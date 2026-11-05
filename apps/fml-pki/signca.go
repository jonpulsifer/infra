package main

import (
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"io"
	"path/filepath"
	"time"
)

// issuingPrefix names the issuing CA that OpenBao holds, folly-issuing-ca.pem,
// signed by the root directly: the intermediate's pathLen 1 leaves no room for
// the CAs beneath it.
const issuingPrefix = "folly-issuing-ca"

type signCAOpts struct {
	certsDir    string
	rootKeyPath string
	csrPath     string
	outPath     string
	pathLen     int
	notAfter    time.Time
}

func readCSR(path string) (*x509.CertificateRequest, error) {
	raw, err := readBytes(path)
	if err != nil {
		return nil, err
	}
	for rest := raw; len(rest) > 0; {
		var block *pem.Block
		block, rest = pem.Decode(rest)
		if block == nil {
			break
		}
		if block.Type != "CERTIFICATE REQUEST" {
			continue
		}
		csr, err := x509.ParseCertificateRequest(block.Bytes)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
		return csr, nil
	}
	return nil, fmt.Errorf("%s: no certificate request", path)
}

// runSignCA signs a CA's certificate request with the root key: the one
// ceremony-side step of the OpenBao PKI, where the key never leaves the server.
func runSignCA(o signCAOpts, out io.Writer) error {
	root, err := readCert(filepath.Join(o.certsDir, "fml-root.pem"))
	if err != nil {
		return err
	}
	rootKey, err := readPrivateKey(o.rootKeyPath)
	if err != nil {
		return err
	}
	want, err := spkiSHA256(root.PublicKey)
	if err != nil {
		return err
	}
	got, err := spkiSHA256(rootKey.Public())
	if err != nil {
		return err
	}
	if want != got {
		return fmt.Errorf("the root key does not match fml-root.pem")
	}

	csr, err := readCSR(o.csrPath)
	if err != nil {
		return err
	}
	// The request proves possession of the key it carries.
	if err := csr.CheckSignature(); err != nil {
		return fmt.Errorf("%s: %w", o.csrPath, err)
	}
	if o.pathLen < 0 {
		return fmt.Errorf("path-len must be 0 or more")
	}
	if limit, ok := pathLen(root); ok && limit < o.pathLen+1 {
		return fmt.Errorf("the root carries pathLen=%d, which does not admit a CA with pathLen=%d beneath it", limit, o.pathLen)
	}
	if o.notAfter.After(root.NotAfter) {
		return fmt.Errorf("notAfter %s is after the root's %s",
			o.notAfter.UTC().Format(time.RFC3339), root.NotAfter.UTC().Format(time.RFC3339))
	}

	sn, err := serial()
	if err != nil {
		return err
	}
	tmpl := &x509.Certificate{
		SerialNumber:          sn,
		RawSubject:            csr.RawSubject,
		NotBefore:             time.Now().UTC().Add(-time.Minute),
		NotAfter:              o.notAfter,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLen:            o.pathLen,
		MaxPathLenZero:        o.pathLen == 0,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, root, csr.PublicKey, rootKey)
	if err != nil {
		return err
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return err
	}

	roots := x509.NewCertPool()
	roots.AddCert(root)
	if _, err := cert.Verify(x509.VerifyOptions{
		Roots:     roots,
		KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageAny},
	}); err != nil {
		return fmt.Errorf("the new certificate does not verify against the root: %w", err)
	}
	if err := writePEM(o.outPath, "CERTIFICATE", der, 0o644); err != nil {
		return err
	}

	spki, err := spkiSHA256(csr.PublicKey)
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "==> signed %s\n", cert.Subject)
	fmt.Fprintf(out, "      key %s, spki sha256 %x\n", keyAlgorithm(csr.PublicKey), spki)
	fmt.Fprintf(out, "      pathLen %d, notAfter %s\n", o.pathLen, cert.NotAfter.UTC().Format(time.RFC3339))
	fmt.Fprintf(out, "      wrote %s\n", o.outPath)
	return nil
}
