// Command fml-pki is the crypto half of the FML PKI tooling: it verifies the
// committed chain, reissues the trust anchors, derives the OIDC documents, and
// answers the certificate questions the rotation scripts used to shell out for.
//
// Standard library only, so the toolchain needs go and nothing else. It exists
// because the shell path needed openssl, which neither mise's registry nor the
// dev shell carried, and because reading basicConstraints out of DER by hand to
// find a pathLen is a bad way to learn that a hierarchy contradicts itself.
package main

import (
	"crypto/sha256"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// errFailed marks an assertion failure rather than an operational one, so the
// caller can exit non-zero without printing a redundant error line.
var errFailed = errors.New("checks failed")

// repoCertsDir walks up from the working directory looking for the certificate
// tree. Callers reach this binary through `go -C apps/fml-pki run .`, which
// leaves the process in the module directory rather than the repository root,
// so a plain relative path resolves to nothing.
func repoCertsDir() string {
	if v := os.Getenv("FML_PKI_CERTS_DIR"); v != "" {
		return v
	}
	rel := filepath.Join("terraform", "pki", "certs")
	dir, err := os.Getwd()
	if err != nil {
		return rel
	}
	for {
		candidate := filepath.Join(dir, rel)
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return rel
		}
		dir = parent
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `usage: fml-pki <command> [options]

  verify                       assert the committed chain links, anchors and admits its depth
  reissue                      mint replacement trust anchors with correct pathLen
  jwks                         write jwks.json and openid-configuration.json
  fingerprint <cert.pem>       SHA256 over the DER certificate
  spki <cert-or-key.pem>       SHA256 over the DER SubjectPublicKeyInfo
  expired <cert.pem>           exit 0 if notAfter has passed
  inspect <cert.pem>...        subject, serial and validity for each

FML_PKI_CERTS_DIR overrides the certificate directory (default terraform/pki/certs).
`)
	os.Exit(2)
}

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	var err error
	switch os.Args[1] {
	case "verify":
		err = runVerify(repoCertsDir(), os.Stdout, os.Stderr)
	case "reissue":
		err = cmdReissue(os.Args[2:])
	case "jwks":
		err = cmdJWKS(os.Args[2:])
	case "fingerprint":
		err = cmdFingerprint(os.Args[2:])
	case "spki":
		err = cmdSPKI(os.Args[2:])
	case "expired":
		err = cmdExpired(os.Args[2:])
	case "inspect":
		err = cmdInspect(os.Args[2:])
	default:
		usage()
	}
	if err != nil {
		if !errors.Is(err, errFailed) {
			fmt.Fprintf(os.Stderr, "fml-pki: %v\n", err)
		}
		os.Exit(1)
	}
}

func cmdReissue(args []string) error {
	fs := flag.NewFlagSet("reissue", flag.ExitOnError)
	rootKey := fs.String("root-key", "", "PEM private key for the FML Root CA (offline; required)")
	intKey := fs.String("intermediate-key", "", "PEM private key for the Intermediate CA (required)")
	rootDays := fs.Int("root-days", 0, "bound the root instead of never expiring")
	intDays := fs.Int("intermediate-days", 0, "bound the intermediate instead of never expiring")
	staging := fs.String("staging", "staging", "output directory name under the certs directory")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *rootKey == "" || *intKey == "" {
		fs.Usage()
		return errFailed
	}
	until := func(days int) time.Time {
		if days <= 0 {
			return noExpiry
		}
		return time.Now().UTC().AddDate(0, 0, days)
	}
	return runReissue(reissueOpts{
		certsDir:       repoCertsDir(),
		rootKeyPath:    *rootKey,
		intKeyPath:     *intKey,
		rootNotAfter:   until(*rootDays),
		intNotAfter:    until(*intDays),
		rootPathLen:    2,
		intPathLen:     1,
		stagingDirName: *staging,
	}, os.Stdout)
}

func cmdJWKS(args []string) error {
	fs := flag.NewFlagSet("jwks", flag.ExitOnError)
	issuer := fs.String("issuer", "", "issuer URL (no trailing slash)")
	out := fs.String("out", "", "output directory")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *issuer == "" || *out == "" || fs.NArg() == 0 {
		fs.Usage()
		return errFailed
	}
	return runJWKS(*issuer, *out, fs.Args(), os.Stderr)
}

func cmdFingerprint(args []string) error {
	if len(args) != 1 {
		usage()
	}
	cert, err := readCert(args[0])
	if err != nil {
		return err
	}
	sum := sha256.Sum256(cert.Raw)
	fmt.Printf("%x\n", sum)
	return nil
}

// cmdSPKI accepts a certificate or a private key so a caller can compare the
// two without knowing which it holds. The bytes are buffered because stdin
// cannot be read twice.
func cmdSPKI(args []string) error {
	if len(args) != 1 {
		usage()
	}
	raw, err := readBytes(args[0])
	if err != nil {
		return err
	}
	var pub any
	if cert, cerr := parseCert(raw, args[0]); cerr == nil {
		pub = cert.PublicKey
	} else {
		key, kerr := parseKey(raw, args[0])
		if kerr != nil {
			return fmt.Errorf("%s is neither a certificate (%v) nor a private key (%v)", args[0], cerr, kerr)
		}
		pub = key.Public()
	}
	sum, err := spkiSHA256(pub)
	if err != nil {
		return err
	}
	fmt.Printf("%x\n", sum)
	return nil
}

func cmdExpired(args []string) error {
	if len(args) != 1 {
		usage()
	}
	cert, err := readCert(args[0])
	if err != nil {
		return err
	}
	if time.Now().After(cert.NotAfter) {
		return nil
	}
	return errFailed
}

func cmdInspect(args []string) error {
	if len(args) == 0 {
		usage()
	}
	// Every certificate, because the files worth inspecting most are the
	// bundle and the chain, and readCert refuses anything but a lone cert.
	for _, p := range args {
		certs, err := readCerts(p)
		if err != nil {
			return err
		}
		for _, cert := range certs {
			fmt.Printf("%s: subject=%s serial=%X notBefore=%s notAfter=%s\n",
				filepath.Base(p), cert.Subject, cert.SerialNumber,
				cert.NotBefore.UTC().Format(time.RFC3339),
				cert.NotAfter.UTC().Format(time.RFC3339))
		}
	}
	return nil
}
