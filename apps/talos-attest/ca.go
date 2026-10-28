package main

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
	"time"
)

// CA is the DevID CA: its key, and its chain from itself up to the FML root.
type CA struct {
	Cert     *x509.Certificate
	Chain    []*x509.Certificate
	key      crypto.Signer
	Validity time.Duration
	Org      string
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
	return NewCA(key, chain, validity)
}

// NewCA checks that key belongs to chain[0], that chain[0] may issue, and
// that each certificate in the chain is signed by the next.
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
	if validity <= 0 {
		return nil, errors.New("certificate validity must be positive")
	}
	return &CA{Cert: ca, Chain: chain, key: key, Validity: validity, Org: "Folly Mountain Laboratories"}, nil
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

// Issue signs a leaf for a TPM-resident key. role is "LDevID" or "LAK"; it
// becomes the subject's OU. The subject carries the machine's name and its
// SMBIOS serial, as IEEE 802.1AR names a DevID.
func (c *CA) Issue(pub crypto.PublicKey, machine, serial, role string, now time.Time) (*x509.Certificate, error) {
	sn, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 127))
	if err != nil {
		return nil, err
	}
	notAfter := now.Add(c.Validity)
	if notAfter.After(c.Cert.NotAfter) {
		notAfter = c.Cert.NotAfter
	}
	tmpl := &x509.Certificate{
		SerialNumber: sn,
		Subject: pkix.Name{
			CommonName:         machine,
			SerialNumber:       serial,
			Organization:       []string{c.Org},
			OrganizationalUnit: []string{role},
		},
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
