package attest

import (
	"bytes"
	"crypto"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"os"
	"slices"
	"strings"
	"time"
)

// CA is the DevID CA: its key, and its chain from itself up to the FML root.
// Issuers are every CA whose leaves fleetd accepts: its own, and the others
// in the bundle, whose LDevIDs stay trusted until their nodes renew them from
// this CA.
type CA struct {
	Cert     *x509.Certificate
	Chain    []*x509.Certificate
	Issuers  []*x509.Certificate
	key      crypto.Signer
	Validity time.Duration
	// Site is the subject's O of every leaf.
	Site string
}

// AddIssuers admits more issuing CAs, from a bundle such as
// terraform/pki/certs/folly-devid-ca.pem. Each must chain to the root of
// this CA's chain through its intermediates or the bundle; a self-signed
// certificate is never admitted. On any failure none is.
func (c *CA) AddIssuers(certs []*x509.Certificate) error {
	candidate := *c
	candidate.Issuers = slices.Clone(c.Issuers)
	for _, cert := range certs {
		if !cert.IsCA || cert.KeyUsage&x509.KeyUsageCertSign == 0 {
			return fmt.Errorf("%s may not sign certificates", cert.Subject)
		}
		if bytes.Equal(cert.RawSubject, cert.RawIssuer) || selfSigned(cert) {
			return fmt.Errorf("issuing CA %s is self-signed; the only root is %s", cert.Subject.CommonName, c.root().Subject.CommonName)
		}
		if slices.ContainsFunc(candidate.Issuers, func(have *x509.Certificate) bool { return bytes.Equal(have.Raw, cert.Raw) }) {
			continue
		}
		candidate.Issuers = append(candidate.Issuers, cert)
	}
	roots, intermediates := candidate.pools()
	for _, cert := range candidate.Issuers {
		if _, err := cert.Verify(x509.VerifyOptions{Roots: roots, Intermediates: intermediates, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageAny}, CurrentTime: cert.NotBefore}); err != nil {
			return fmt.Errorf("issuing CA %s does not chain to this CA's root: %w", cert.Subject.CommonName, err)
		}
	}
	c.Issuers = candidate.Issuers
	return nil
}

// pools are the trust anchor and the intermediates for verifying a leaf:
// the chain's last certificate is the only root, and the rest of the chain
// and every issuing CA are intermediates.
func (c *CA) pools() (roots, intermediates *x509.CertPool) {
	roots, intermediates = x509.NewCertPool(), x509.NewCertPool()
	roots.AddCert(c.root())
	for _, cert := range append(slices.Clone(c.Chain[:len(c.Chain)-1]), c.Issuers...) {
		intermediates.AddCert(cert)
	}
	return roots, intermediates
}

func (c *CA) root() *x509.Certificate { return c.Chain[len(c.Chain)-1] }

func selfSigned(cert *x509.Certificate) bool { return cert.CheckSignatureFrom(cert) == nil }

// Subject is what a leaf names: the IEEE 802.1AR DevID subject, with the
// lifecycle's class as OU and the site as O, so SPIRE can select on either.
type Subject struct {
	Machine string
	Serial  string
	Class   string
}

// LoadCA reads the CA's private key and its chain. The chain file holds the
// DevID CA first and then each issuer up to the root.
func LoadCA(keyPath, chainPath string, validity time.Duration) (*CA, error) {
	kb, err := os.ReadFile(keyPath)
	if err != nil {
		return nil, fmt.Errorf("DevID CA key: %w", err)
	}
	key, err := parseKey(kb)
	if err != nil {
		return nil, fmt.Errorf("DevID CA key %s: %w", keyPath, err)
	}
	chain, err := readChain(chainPath)
	if err != nil {
		return nil, err
	}
	return NewCA(key, chain, validity)
}

// readChain reads a PEM chain file in order, the DevID CA first.
func readChain(chainPath string) ([]*x509.Certificate, error) {
	cb, err := os.ReadFile(chainPath)
	if err != nil {
		return nil, fmt.Errorf("DevID CA chain: %w", err)
	}
	var chain []*x509.Certificate
	for {
		var blk *pem.Block
		blk, cb = pem.Decode(cb)
		if blk == nil {
			break
		}
		c, err := x509.ParseCertificate(blk.Bytes)
		if err != nil {
			return nil, fmt.Errorf("DevID CA chain %s: %w", chainPath, err)
		}
		chain = append(chain, c)
	}
	return chain, nil
}

// NewCA checks that key belongs to chain[0], that chain[0] may issue, that
// each certificate in the chain is signed by the next, and that the last is
// a self-signed root.
func NewCA(key crypto.Signer, chain []*x509.Certificate, validity time.Duration) (*CA, error) {
	if len(chain) == 0 {
		return nil, errors.New("the DevID CA chain is empty")
	}
	ca := chain[0]
	if !ca.IsCA || ca.KeyUsage&x509.KeyUsageCertSign == 0 {
		return nil, fmt.Errorf("%s may not sign certificates", ca.Subject)
	}
	want, err := x509.MarshalPKIXPublicKey(key.Public())
	if err != nil {
		return nil, err
	}
	if !bytes.Equal(want, ca.RawSubjectPublicKeyInfo) {
		return nil, fmt.Errorf("the DevID CA key does not match %s", ca.Subject)
	}
	for i := 0; i+1 < len(chain); i++ {
		if err := chain[i].CheckSignatureFrom(chain[i+1]); err != nil {
			return nil, fmt.Errorf("%s is not signed by %s: %w", chain[i].Subject, chain[i+1].Subject, err)
		}
	}
	if root := chain[len(chain)-1]; !bytes.Equal(root.RawSubject, root.RawIssuer) || !selfSigned(root) {
		return nil, fmt.Errorf("the DevID CA chain ends at %s, which is not a self-signed root", root.Subject)
	}
	if validity <= 0 {
		return nil, errors.New("certificate validity must be positive")
	}
	return &CA{Cert: ca, Chain: chain, Issuers: []*x509.Certificate{ca}, key: key, Validity: validity, Site: "folly"}, nil
}

func parseKey(b []byte) (crypto.Signer, error) {
	blk, _ := pem.Decode(b)
	if blk == nil {
		return nil, errors.New("no PEM block")
	}
	var k any
	var err error
	switch blk.Type {
	case "RSA PRIVATE KEY":
		k, err = x509.ParsePKCS1PrivateKey(blk.Bytes)
	case "EC PRIVATE KEY":
		k, err = x509.ParseECPrivateKey(blk.Bytes)
	default:
		k, err = x509.ParsePKCS8PrivateKey(blk.Bytes)
	}
	if err != nil {
		return nil, err
	}
	s, ok := k.(crypto.Signer)
	if !ok {
		return nil, fmt.Errorf("key type %T cannot sign", k)
	}
	return s, nil
}

// Issue signs a leaf for a TPM-resident key. role is "LDevID" or "LAK": the
// LDevID gets the client-auth EKU, the LAK none. The subject is
// CN=<machine>, serialNumber=<serial>, OU=<class>, O=<site>; OU is left out
// when the machine has no class yet.
func (c *CA) Issue(pub crypto.PublicKey, s Subject, role string, now time.Time) (*x509.Certificate, error) {
	sn, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 127))
	if err != nil {
		return nil, err
	}
	notAfter := now.Add(c.Validity)
	if notAfter.After(c.Cert.NotAfter) {
		notAfter = c.Cert.NotAfter
	}
	name := pkix.Name{
		CommonName:   s.Machine,
		SerialNumber: s.Serial,
		Organization: []string{c.Site},
	}
	if s.Class != "" {
		name.OrganizationalUnit = []string{s.Class}
	}
	tmpl := &x509.Certificate{
		SerialNumber:          sn,
		Subject:               name,
		NotBefore:             now.Add(-5 * time.Minute),
		NotAfter:              notAfter,
		KeyUsage:              x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
	}
	if role == "LDevID" {
		tmpl.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, c.Cert, pub, c.key)
	if err != nil {
		return nil, err
	}
	return x509.ParseCertificate(der)
}

// VerifyLeaf parses the first certificate of a PEM chain and checks that an
// issuing CA fleetd accepts issued it, that it chains to the root and
// is valid at now, and that it names machine and serial.
func (c *CA) VerifyLeaf(pemChain, machine, serial string, now time.Time) (*x509.Certificate, error) {
	blk, _ := pem.Decode([]byte(pemChain))
	if blk == nil || blk.Type != "CERTIFICATE" {
		return nil, errors.New("no PEM certificate")
	}
	leaf, err := x509.ParseCertificate(blk.Bytes)
	if err != nil {
		return nil, err
	}
	roots, intermediates := c.pools()
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: roots, Intermediates: intermediates, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageAny}, CurrentTime: now}); err != nil {
		return nil, err
	}
	if !slices.ContainsFunc(c.Issuers, func(issuer *x509.Certificate) bool { return leaf.CheckSignatureFrom(issuer) == nil }) {
		return nil, fmt.Errorf("not issued by %s", c.issuerNames())
	}
	if leaf.Subject.CommonName != machine || !strings.EqualFold(strings.TrimSpace(leaf.Subject.SerialNumber), strings.TrimSpace(serial)) {
		return nil, fmt.Errorf("names %s %s, not %s %s", leaf.Subject.CommonName, leaf.Subject.SerialNumber, machine, serial)
	}
	return leaf, nil
}

func (c *CA) issuerNames() string {
	names := make([]string, 0, len(c.Issuers))
	for _, issuer := range c.Issuers {
		names = append(names, issuer.Subject.CommonName)
	}
	return strings.Join(names, ", ")
}

// ChainPEM is the DevID CA up to the root.
func (c *CA) ChainPEM() []byte {
	var b bytes.Buffer
	for _, cert := range c.Chain {
		_ = pem.Encode(&b, &pem.Block{Type: "CERTIFICATE", Bytes: cert.Raw})
	}
	return b.Bytes()
}

// LeafPEM is a leaf followed by the DevID CA.
func (c *CA) LeafPEM(leaf *x509.Certificate) []byte {
	var b bytes.Buffer
	_ = pem.Encode(&b, &pem.Block{Type: "CERTIFICATE", Bytes: leaf.Raw})
	_ = pem.Encode(&b, &pem.Block{Type: "CERTIFICATE", Bytes: c.Cert.Raw})
	return b.Bytes()
}

func serialHex(c *x509.Certificate) string { return hex.EncodeToString(c.SerialNumber.Bytes()) }
