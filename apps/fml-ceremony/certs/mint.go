// Package certs mints the FML Root and Intermediate deterministically, so that
// the same master seed produces byte-identical certificates on any machine.
//
// apps/fml-pki's reissue path cannot be reused as-is for two reasons that both
// matter. It draws the serial from crypto/rand and stamps notBefore from
// time.Now(), so two runs never agree; and it deliberately carries the previous
// SubjectKeyId so that already-issued certificates find their issuer, which is
// exactly right for a same-key reissue and exactly wrong for a re-birth, where
// the key is new and the identifier must be too.
package certs

import (
	"crypto/ed25519"
	"crypto/hkdf"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"math/big"
	"time"
)

// NoExpiry is RFC 5280's "no well-defined expiration date". The anchors are
// pinned on every node out of band, so an expiry adds an outage and no security.
var NoExpiry = time.Date(9999, 12, 31, 23, 59, 59, 0, time.UTC)

// The serial derives from the public key, so a verifier holding only the
// transcript can recompute it without any secret.
const serialSalt = "fml-cert-serial-v1"

// SerialOctets matches the size of apps/fml-pki's random serial.
const SerialOctets = 16

// Profile is every input a reproducible certificate needs. None comes from the
// clock or a random source.
type Profile struct {
	// The leaf path the signing key was derived at, and the serial's domain separator.
	Path string
	// Carried verbatim from the certificate being replaced: round-tripping
	// through pkix.Name can reorder or drop attributes.
	RawSubject []byte
	MaxPathLen int
	NotBefore  time.Time
	NotAfter   time.Time
}

// Serial derives a certificate serial from its public key and derivation path.
// RFC 5280 requires a positive integer of at most 20 octets.
func Serial(pub ed25519.PublicKey, path string) (*big.Int, error) {
	okm, err := hkdf.Key(sha256.New, pub, []byte(serialSalt), path, SerialOctets)
	if err != nil {
		return nil, err
	}
	sn := new(big.Int).SetBytes(okm)
	if sn.Sign() <= 0 {
		return nil, fmt.Errorf("certs: derived serial for %q is not positive", path)
	}
	return sn, nil
}

// DER prepends a zero octet when the high bit is set, so SerialOctets may not
// exceed 19 under RFC 5280's 20-octet cap. This fails to compile otherwise.
const _ = uint(19 - SerialOctets)

// RFC 5280 key identifier method (1): SHA-1 over the Ed25519 public key.
// Computed here so determinism does not depend on crypto/x509's derivation.
func subjectKeyID(pub ed25519.PublicKey) []byte {
	sum := sha1.Sum(pub)
	return sum[:]
}

func template(p Profile, pub ed25519.PublicKey) (*x509.Certificate, error) {
	if len(p.RawSubject) == 0 {
		return nil, errors.New("certs: no subject")
	}
	if p.NotBefore.IsZero() || p.NotAfter.IsZero() {
		return nil, errors.New("certs: notBefore and notAfter must be pinned, not taken from the clock")
	}
	if !p.NotBefore.Before(p.NotAfter) {
		return nil, fmt.Errorf("certs: notBefore %s is not before notAfter %s", p.NotBefore, p.NotAfter)
	}
	sn, err := Serial(pub, p.Path)
	if err != nil {
		return nil, err
	}
	return &x509.Certificate{
		SerialNumber: sn,
		RawSubject:   p.RawSubject,
		SubjectKeyId: subjectKeyID(pub),
		NotBefore:    p.NotBefore.UTC(),
		NotAfter:     p.NotAfter.UTC(),
		KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign |
			x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLen:            p.MaxPathLen,
		// Without it, MaxPathLen 0 means no path length constraint.
		MaxPathLenZero: p.MaxPathLen == 0,
	}, nil
}

// Ed25519 signing ignores the reader, so any read means the certificate needs
// randomness and could not be reproduced.
type nilReader struct{}

func (nilReader) Read([]byte) (int, error) {
	return 0, errors.New("certs: certificate creation asked for randomness, which would make it unreproducible")
}

var _ io.Reader = nilReader{}

// SelfSigned mints the root.
func SelfSigned(key ed25519.PrivateKey, p Profile) ([]byte, error) {
	pub, ok := key.Public().(ed25519.PublicKey)
	if !ok {
		return nil, fmt.Errorf("certs: signing key is %T, want ed25519", key.Public())
	}
	tmpl, err := template(p, pub)
	if err != nil {
		return nil, err
	}
	return x509.CreateCertificate(nilReader{}, tmpl, tmpl, pub, key)
}

// SignedBy mints the intermediate. parent must be the parsed new root, so the
// intermediate's authorityKeyIdentifier names the root's new key.
func SignedBy(key ed25519.PrivateKey, p Profile, parent *x509.Certificate, parentKey ed25519.PrivateKey) ([]byte, error) {
	pub, ok := key.Public().(ed25519.PublicKey)
	if !ok {
		return nil, fmt.Errorf("certs: signing key is %T, want ed25519", key.Public())
	}
	tmpl, err := template(p, pub)
	if err != nil {
		return nil, err
	}
	return x509.CreateCertificate(nilReader{}, tmpl, parent, pub, parentKey)
}
