package attest

import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/asn1"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/go-attestation/attest"

	"github.com/jonpulsifer/infra/apps/fleetd/protocol"
)

var oidSubjectAltName = asn1.ObjectIdentifier{2, 5, 29, 17}

// EKRoots holds the pinned TPM manufacturer certificates: the self-signed
// ones anchor a chain, the rest may sit between an anchor and an EK.
type EKRoots struct {
	roots         *x509.CertPool
	intermediates *x509.CertPool
	Count         int
}

// LoadEKRoots reads every PEM certificate in dir.
func LoadEKRoots(dir string) (*EKRoots, error) {
	paths, err := filepath.Glob(filepath.Join(dir, "*.pem"))
	if err != nil {
		return nil, err
	}
	r := &EKRoots{roots: x509.NewCertPool(), intermediates: x509.NewCertPool()}
	for _, p := range paths {
		b, err := os.ReadFile(p)
		if err != nil {
			return nil, err
		}
		for {
			var blk *pem.Block
			blk, b = pem.Decode(b)
			if blk == nil {
				break
			}
			c, err := x509.ParseCertificate(blk.Bytes)
			if err != nil {
				return nil, fmt.Errorf("%s: %w", p, err)
			}
			r.Add(c)
		}
	}
	if r.Count == 0 {
		return nil, fmt.Errorf("no EK roots in %s", dir)
	}
	return r, nil
}

// Add pins one manufacturer certificate.
func (r *EKRoots) Add(c *x509.Certificate) {
	if bytes.Equal(c.RawSubject, c.RawIssuer) && c.CheckSignatureFrom(c) == nil {
		r.roots.AddCert(c)
	} else {
		r.intermediates.AddCert(c)
	}
	r.Count++
}

// VerifiedEK is an endorsement key whose certificate chains to a pinned
// manufacturer, or whose hash the inventory pins when the TPM has no
// certificate.
type VerifiedEK struct {
	Public crypto.PublicKey
	Alg    string
	Hash   string
	Issuer string
}

// EKHash is the lowercase hex SHA-256 of the key's DER SubjectPublicKeyInfo,
// the value the SPIRE TPM plugin and the inventory use.
func EKHash(pub crypto.PublicKey) (string, error) {
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(der)
	return hex.EncodeToString(sum[:]), nil
}

func ekAlg(pub crypto.PublicKey) (string, error) {
	switch k := pub.(type) {
	case *rsa.PublicKey:
		if k.N.BitLen() < 2048 {
			return "", fail(reasonEKWeak, "RSA EK of %d bits", k.N.BitLen())
		}
		if rocaVulnerable(k.N) {
			return "", fail(reasonEKROCA, "the RSA EK carries the ROCA fingerprint (CVE-2017-15361)")
		}
		return "rsa", nil
	case *ecdsa.PublicKey:
		if k.Curve != elliptic.P256() && k.Curve != elliptic.P384() {
			return "", fail(reasonEKWeak, "EK curve %s", k.Curve.Params().Name)
		}
		return "ecc", nil
	default:
		return "", fail(reasonEKWeak, "EK key type %T", pub)
	}
}

// Verify checks one endorsement key. A certificate must chain to a pinned
// manufacturer and hold the presented public key.
func (r *EKRoots) Verify(ek protocol.EK, now time.Time) (VerifiedEK, error) {
	if len(ek.Public) == 0 {
		return VerifiedEK{}, fail(reasonEKMissing, "an EK has no public key")
	}
	pub, err := x509.ParsePKIXPublicKey(ek.Public)
	if err != nil {
		return VerifiedEK{}, fail(reasonEKMissing, "EK public key: %v", err)
	}
	v := VerifiedEK{Public: pub}
	if v.Alg, err = ekAlg(pub); err != nil {
		return VerifiedEK{}, err
	}
	if v.Hash, err = EKHash(pub); err != nil {
		return VerifiedEK{}, fail(reasonEKMissing, "EK hash: %v", err)
	}
	if len(ek.Cert) == 0 {
		return v, nil
	}
	cert, err := attest.ParseEKCertificate(ek.Cert)
	if err != nil {
		return VerifiedEK{}, fail(reasonEKChain, "EK certificate: %v", err)
	}
	der, err := x509.MarshalPKIXPublicKey(cert.PublicKey)
	if err != nil || !bytes.Equal(der, ek.Public) {
		return VerifiedEK{}, fail(reasonEKMismatch, "the EK certificate names another key")
	}
	// Go does not process the TCG directory name in an EK certificate's
	// critical subjectAltName; it names the TPM's maker and model only.
	unhandled := cert.UnhandledCriticalExtensions[:0]
	for _, oid := range cert.UnhandledCriticalExtensions {
		if !oid.Equal(oidSubjectAltName) {
			unhandled = append(unhandled, oid)
		}
	}
	cert.UnhandledCriticalExtensions = unhandled
	if _, err := cert.Verify(x509.VerifyOptions{
		Roots:         r.roots,
		Intermediates: r.intermediates,
		CurrentTime:   now,
		KeyUsages:     []x509.ExtKeyUsage{x509.ExtKeyUsageAny},
	}); err != nil {
		return VerifiedEK{}, fail(reasonEKChain, "EK certificate from %q: %v", cert.Issuer.CommonName, err)
	}
	v.Issuer = cert.Issuer.CommonName
	return v, nil
}

// Failure is a refusal with a stable reason. Unauthenticated marks one that
// nothing the machine's TPM signed led to; it is answered as a refusal and
// recorded against no machine. Unquarantined marks a control-plane node's
// failed check, which is recorded and alerts but leaves the node in place.
type Failure struct {
	Reason          string
	Detail          string
	Unauthenticated bool
	Unquarantined   bool
}

func (f *Failure) Error() string { return f.Reason + ": " + f.Detail }

func fail(reason, format string, args ...any) error {
	return &Failure{Reason: reason, Detail: fmt.Sprintf(format, args...)}
}

func reasonOf(err error) string {
	var f *Failure
	if errors.As(err, &f) {
		return f.Reason
	}
	return reasonInternal
}

const (
	reasonUnknownMachine = "unknown-machine"
	reasonMACMismatch    = "mac-mismatch"
	reasonMACInvalid     = "invalid-mac"
	reasonEKMissing      = "ek-missing"
	reasonEKWeak         = "ek-weak"
	reasonEKROCA         = "ek-roca"
	reasonEKChain        = "ek-chain"
	reasonEKMismatch     = "ek-mismatch"
	reasonEKUnpinned     = "ek-unpinned"
	reasonEKHash         = "ek-hash-mismatch"
	reasonEKPending      = "ek-pending-approval"
	reasonBinding        = "ek-binding-changed"
	reasonAK             = "ak-invalid"
	reasonSession        = "session"
	reasonConfirm        = "confirm-signature"
	reasonActivation     = "activation"
	reasonQuote          = "quote"
	reasonEventLog       = "event-log"
	reasonPolicy         = "policy"
	reasonLDevID         = "ldevid"
	reasonStatus         = "status"
	reasonDevID          = "devid-on-file"
	reasonUnattended     = "unattended-boot"
	reasonNetBox         = "netbox-unavailable"
	reasonSerial         = "invalid-serial"
	reasonInternal       = "internal"
)

func normalMAC(m string) string {
	return strings.ToLower(strings.ReplaceAll(strings.TrimSpace(m), "-", ":"))
}
