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

// NoExpiry is RFC 5280's "no well-defined expiration date", which is what both
// anchors already carry. They are distributed out of band and pinned on every
// node, so a date on them buys a fleet-wide outage nobody is watching for
// rather than any security.
var NoExpiry = time.Date(9999, 12, 31, 23, 59, 59, 0, time.UTC)

// serialSalt frames the serial derivation. The serial is derived from the
// certificate's own public key rather than from its private seed, so a verifier
// holding only the transcript can recompute and check it without any secret.
const serialSalt = "fml-cert-serial-v1"

// SerialOctets is 16, matching what apps/fml-pki's random serial produces. DER
// adds at most one leading zero octet, so the encoded INTEGER is at most 17
// octets and stays inside RFC 5280's 20-octet ceiling.
const SerialOctets = 16

// Profile is everything the ceremony must pin for a certificate to be
// reproducible. Nothing here is read from the clock or from a random source.
type Profile struct {
	// Path is the leaf path the signing key was derived at. It is the serial's
	// domain separator, which is what keeps two certificates for two different
	// keys from ever colliding.
	Path string
	// RawSubject is the DER-encoded subject, carried verbatim from the
	// certificate being replaced rather than rebuilt from a pkix.Name.
	// Round-tripping through pkix.Name can reorder or drop attributes, and
	// these certificates have to stay interchangeable with the ones already
	// distributed.
	RawSubject []byte
	MaxPathLen int
	NotBefore  time.Time
	NotAfter   time.Time
}

// Serial derives a certificate serial from its public key (SPEC.md's tree gives
// the path; the key gives the material). RFC 5280 requires a positive integer
// of at most 20 octets.
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

// RFC 5280 caps a serial at 20 octets, and DER prepends a zero octet when the
// high bit is set, so SerialOctets may not exceed 19. Asserted at compile time:
// a runtime check could never fire while SerialOctets is a constant, which is
// validation that only reads like validation.
const _ = uint(19 - SerialOctets)

// subjectKeyID is RFC 5280 section 4.2.1.2 method (1): SHA-1 over the
// subjectPublicKey BIT STRING contents, which for Ed25519 is the 32-octet
// public key. Computed here rather than left to crypto/x509 to derive, because
// a re-birth's whole determinism claim should not rest on an unexported
// derivation in a package that is allowed to change it.
//
// SHA-1 is an identifier here, not a security property: it names a key so a
// chain builder can match authorityKeyIdentifier to subjectKeyIdentifier.
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
		// Only meaningful at maxPathLen 0, where it is the difference between
		// pathLen:0 and no constraint at all.
		MaxPathLenZero: p.MaxPathLen == 0,
	}, nil
}

// nilReader is the entropy source handed to x509.CreateCertificate. Ed25519
// signatures are deterministic per RFC 8032 and crypto/ed25519 ignores the
// reader entirely, so a certificate that needs randomness to be created is a
// certificate that cannot be reproduced. Failing loudly beats discovering that
// in twenty years.
type nilReader struct{}

func (nilReader) Read([]byte) (int, error) {
	return 0, errors.New("certs: certificate creation asked for randomness, which would make it unreproducible")
}

var _ io.Reader = nilReader{}

// SelfSigned mints the root: signed by its own key, anchoring the chain.
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

// SignedBy mints the intermediate under the freshly minted root. parent must be
// the parsed root certificate, so that the intermediate's
// authorityKeyIdentifier names the root's new key rather than the old one.
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
