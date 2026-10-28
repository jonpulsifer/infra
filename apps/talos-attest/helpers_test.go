package main

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/pem"
	"math/big"
	"os"
	"testing"
	"time"

	"github.com/google/go-attestation/attest"
)

// testCA is a throwaway issuer for EK and DevID chains.
type testCA struct {
	cert *x509.Certificate
	key  crypto.Signer
}

func newTestCA(t *testing.T, name string, parent *testCA, pathLen int) *testCA {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(time.Now().UnixNano()),
		Subject:               pkix.Name{CommonName: name},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(5 * 365 * 24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		MaxPathLen:            pathLen,
		MaxPathLenZero:        pathLen == 0,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
	}
	issuer, signer := tmpl, crypto.Signer(key)
	if parent != nil {
		issuer, signer = parent.cert, parent.key
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, issuer, key.Public(), signer)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return &testCA{cert: cert, key: key}
}

// issueEK makes an EK certificate the way a TPM maker does: empty subject,
// keyEncipherment or keyAgreement, the TCG EK EKU.
func (c *testCA) issueEK(t *testing.T, pub crypto.PublicKey) []byte {
	t.Helper()
	tmpl := &x509.Certificate{
		SerialNumber:       big.NewInt(time.Now().UnixNano()),
		NotBefore:          time.Now().Add(-time.Hour),
		NotAfter:           time.Now().Add(24 * time.Hour),
		KeyUsage:           x509.KeyUsageKeyEncipherment,
		UnknownExtKeyUsage: []asn1.ObjectIdentifier{{2, 23, 133, 8, 1}},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, c.cert, pub, c.key)
	if err != nil {
		t.Fatal(err)
	}
	return der
}

// devIDCA is a root, an intermediate with pathLen 1 and a DevID CA below
// it, the shape of the FML chain.
func devIDCA(t *testing.T) *CA {
	t.Helper()
	root := newTestCA(t, "Test Root", nil, 2)
	inter := newTestCA(t, "Test Intermediate", root, 1)
	dev := newTestCA(t, "Test DevID CA", inter, 0)
	ca, err := NewCA(dev.key, []*x509.Certificate{dev.cert, inter.cert, root.cert}, 365*24*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	return ca
}

func writePEM(t *testing.T, path, typ string, der []byte) {
	t.Helper()
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: typ, Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// replayPCRs computes PCRs 0-7 in the SHA-256 bank from an event log, the
// values its machine's TPM held.
func replayPCRs(t *testing.T, raw []byte) map[int][]byte {
	t.Helper()
	el, err := attest.ParseEventLog(raw)
	if err != nil {
		t.Fatal(err)
	}
	pcrs := map[int][]byte{}
	for i := 0; i < 8; i++ {
		pcrs[i] = make([]byte, 32)
	}
	for _, e := range el.Events(attest.HashSHA256) {
		if e.Index > 7 {
			continue
		}
		h := sha256.New()
		h.Write(pcrs[e.Index])
		h.Write(e.Digest)
		pcrs[e.Index] = h.Sum(nil)
	}
	return pcrs
}

func attestPCRs(m map[int][]byte) []attest.PCR {
	out := make([]attest.PCR, 0, len(m))
	for i := 0; i < 8; i++ {
		out = append(out, attest.PCR{Index: i, Digest: m[i], DigestAlg: crypto.SHA256})
	}
	return out
}
