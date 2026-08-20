package main

import (
	"crypto/rand"
	"crypto/x509"
	"fmt"
	"io"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// noExpiry is RFC 5280's "no well-defined expiration date". These anchors are
// distributed out of band and pinned on every node, so a date on them buys a
// fleet-wide outage nobody is watching for rather than any security. Rotation
// is exercised on the short-lived cluster CAs beneath them.
var noExpiry = time.Date(9999, 12, 31, 23, 59, 59, 0, time.UTC)

func serial() (*big.Int, error) {
	return rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
}

// caTemplate builds a CA certificate that keeps the previous subject verbatim.
// RawSubject rather than Subject: round-tripping through pkix.Name can reorder
// or drop attributes, and these certificates have to stay interchangeable with
// the ones already distributed.
func caTemplate(prev *x509.Certificate, maxPathLen int, notAfter time.Time) (*x509.Certificate, error) {
	sn, err := serial()
	if err != nil {
		return nil, err
	}
	return &x509.Certificate{
		SerialNumber: sn,
		RawSubject:   prev.RawSubject,
		// Carry the previous subject key identifier rather than letting Go
		// derive one. Every certificate already issued beneath these anchors
		// names its issuer by that value in its authorityKeyIdentifier, and
		// OpenSSL builds chains by matching the two. Go's derivation differs
		// from the one that minted the originals, so deriving here would leave
		// the existing cluster CAs unable to find their own issuer.
		SubjectKeyId:          prev.SubjectKeyId,
		NotBefore:             time.Now().UTC().Add(-time.Minute),
		NotAfter:              notAfter,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLen:            maxPathLen,
		// Only meaningful for maxPathLen 0, where it is the difference between
		// pathLen:0 and no constraint at all. Terraform's provider has no such
		// flag, which is why its `max_path_length = 0` emits nothing.
		MaxPathLenZero: maxPathLen == 0,
	}, nil
}

type reissueOpts struct {
	certsDir       string
	rootKeyPath    string
	intKeyPath     string
	rootNotAfter   time.Time
	intNotAfter    time.Time
	rootPathLen    int
	intPathLen     int
	stagingDirName string
}

func runReissue(o reissueOpts, out io.Writer) error {
	prevRoot, err := readCert(filepath.Join(o.certsDir, "fml-root.pem"))
	if err != nil {
		return err
	}
	prevInt, err := readCert(filepath.Join(o.certsDir, "fml-intermediate.pem"))
	if err != nil {
		return err
	}
	rootKey, err := readPrivateKey(o.rootKeyPath)
	if err != nil {
		return err
	}
	intKey, err := readPrivateKey(o.intKeyPath)
	if err != nil {
		return err
	}

	fmt.Fprintf(out, "==> root subject:         %s\n", prevRoot.Subject)
	fmt.Fprintf(out, "==> intermediate subject: %s\n", prevInt.Subject)
	fmt.Fprintf(out, "==> root key algorithm:   %s\n", keyAlgorithm(rootKey.Public()))

	// A key that does not match the certificate it is replacing would mint an
	// anchor nothing beneath it chains to.
	for _, pair := range []struct {
		name string
		cert *x509.Certificate
		have any
	}{
		{"root", prevRoot, rootKey.Public()},
		{"intermediate", prevInt, intKey.Public()},
	} {
		want, err := spkiSHA256(pair.cert.PublicKey)
		if err != nil {
			return err
		}
		got, err := spkiSHA256(pair.have)
		if err != nil {
			return err
		}
		if want != got {
			return fmt.Errorf("the %s key does not match the %s certificate it replaces", pair.name, pair.name)
		}
	}

	fmt.Fprintf(out, "==> reissuing the root, self-signed, pathlen:%d\n", o.rootPathLen)
	rootTmpl, err := caTemplate(prevRoot, o.rootPathLen, o.rootNotAfter)
	if err != nil {
		return err
	}
	rootDER, err := x509.CreateCertificate(rand.Reader, rootTmpl, rootTmpl, rootKey.Public(), rootKey)
	if err != nil {
		return err
	}
	newRoot, err := x509.ParseCertificate(rootDER)
	if err != nil {
		return err
	}

	fmt.Fprintf(out, "==> reissuing the intermediate off the new root, pathlen:%d\n", o.intPathLen)
	intTmpl, err := caTemplate(prevInt, o.intPathLen, o.intNotAfter)
	if err != nil {
		return err
	}
	intDER, err := x509.CreateCertificate(rand.Reader, intTmpl, newRoot, intKey.Public(), rootKey)
	if err != nil {
		return err
	}
	newInt, err := x509.ParseCertificate(intDER)
	if err != nil {
		return err
	}

	// The anchors are only useful if the cluster CAs already in the tree still
	// chain through them. Go enforces pathLenConstraint while building, so this
	// catches the defect these anchors exist to fix.
	roots := x509.NewCertPool()
	roots.AddCert(newRoot)
	inter := x509.NewCertPool()
	inter.AddCert(newInt)

	fmt.Fprintln(out, "==> verifying the new anchors accept the existing cluster CAs")
	matches, err := filepath.Glob(filepath.Join(o.certsDir, "*-ca.pem"))
	if err != nil {
		return err
	}
	for _, m := range matches {
		base := filepath.Base(m)
		if strings.HasPrefix(base, "fml-") {
			continue
		}
		ca, err := readCert(m)
		if err != nil {
			return err
		}
		if _, err := ca.Verify(x509.VerifyOptions{
			Roots:         roots,
			Intermediates: inter,
			KeyUsages:     []x509.ExtKeyUsage{x509.ExtKeyUsageAny},
		}); err != nil {
			return fmt.Errorf("%s does not verify against the new anchors: %w", base, err)
		}
		fmt.Fprintf(out, "      %s verifies\n", base)
	}

	staging := filepath.Join(o.certsDir, o.stagingDirName)
	if err := os.MkdirAll(staging, 0o755); err != nil {
		return err
	}
	rootOut := filepath.Join(staging, "fml-root.pem")
	intOut := filepath.Join(staging, "fml-intermediate.pem")
	if err := writePEM(rootOut, "CERTIFICATE", rootDER, 0o644); err != nil {
		return err
	}
	if err := writePEM(intOut, "CERTIFICATE", intDER, 0o644); err != nil {
		return err
	}

	fmt.Fprintf(out, "\n==> wrote:\n      %s\n      %s\n", rootOut, intOut)
	fmt.Fprintf(out, "      root notAfter %s, intermediate notAfter %s\n",
		newRoot.NotAfter.UTC().Format(time.RFC3339), newInt.NotAfter.UTC().Format(time.RFC3339))
	return nil
}
