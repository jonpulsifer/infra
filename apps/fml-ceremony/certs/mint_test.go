package certs

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/hex"
	"runtime"
	"testing"
	"time"

	"github.com/jonpulsifer/infra/apps/fml-ceremony/derive"
)

var notBefore = time.Date(2026, 8, 26, 0, 0, 0, 0, time.UTC)

func subject(t *testing.T, cn string) []byte {
	t.Helper()
	der, err := asn1.Marshal(pkix.Name{CommonName: cn}.ToRDNSequence())
	if err != nil {
		t.Fatal(err)
	}
	return der
}

type anchors struct {
	rootDER, intDER   []byte
	rootKey, intKey   ed25519.PrivateKey
	rootCert, intCert *x509.Certificate
}

func mint(t *testing.T, masterHex string) anchors {
	t.Helper()
	master, err := hex.DecodeString(masterHex)
	if err != nil {
		t.Fatal(err)
	}
	rootMat, err := derive.MintFromMaster(master, "fml/infra/v1/pki/root/v1")
	if err != nil {
		t.Fatal(err)
	}
	intMat, err := derive.MintFromMaster(master, "fml/infra/v1/pki/intermediate/v1")
	if err != nil {
		t.Fatal(err)
	}
	// Two CA levels sit below the root and one below the intermediate.
	rootDER, err := SelfSigned(rootMat.Ed25519, Profile{
		Path:       rootMat.Leaf.Path,
		RawSubject: subject(t, "Folly Mountain Laboratories Root CA"),
		MaxPathLen: 2,
		NotBefore:  notBefore,
		NotAfter:   NoExpiry,
	})
	if err != nil {
		t.Fatal(err)
	}
	rootCert, err := x509.ParseCertificate(rootDER)
	if err != nil {
		t.Fatal(err)
	}
	intDER, err := SignedBy(intMat.Ed25519, Profile{
		Path:       intMat.Leaf.Path,
		RawSubject: subject(t, "Folly Mountain Laboratories Intermediate CA"),
		MaxPathLen: 1,
		NotBefore:  notBefore,
		NotAfter:   NoExpiry,
	}, rootCert, rootMat.Ed25519)
	if err != nil {
		t.Fatal(err)
	}
	intCert, err := x509.ParseCertificate(intDER)
	if err != nil {
		t.Fatal(err)
	}
	return anchors{rootDER, intDER, rootMat.Ed25519, intMat.Ed25519, rootCert, intCert}
}

// Only Ed25519 anchors can pass this: RFC 8032 signatures are deterministic.
func TestMintIsBitIdentical(t *testing.T) {
	const master = "2d85dabefa504eefea7740977b1f9110daf404cc24422896a209b41eca970218"
	a := mint(t, master)
	b := mint(t, master)
	if !bytes.Equal(a.rootDER, b.rootDER) {
		t.Fatalf("root DER differs between runs:\n%x\n%x", a.rootDER, b.rootDER)
	}
	if !bytes.Equal(a.intDER, b.intDER) {
		t.Fatalf("intermediate DER differs between runs:\n%x\n%x", a.intDER, b.intDER)
	}
	// Guards against the equality above passing on a constant.
	c := mint(t, "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
	if bytes.Equal(a.rootDER, c.rootDER) {
		t.Fatal("two different masters minted the same root")
	}
}

func TestSignatureIgnoresRandomness(t *testing.T) {
	key := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{7}, 32))
	p := Profile{
		Path:       "fml/infra/v1/pki/root/v1",
		RawSubject: subject(t, "Folly Mountain Laboratories Root CA"),
		MaxPathLen: 2,
		NotBefore:  notBefore,
		NotAfter:   NoExpiry,
	}
	tmpl, err := template(p, key.Public().(ed25519.PublicKey))
	if err != nil {
		t.Fatal(err)
	}
	withNil, err := x509.CreateCertificate(nilReader{}, tmpl, tmpl, key.Public(), key)
	if err != nil {
		t.Fatalf("certificate creation consumed randomness: %v", err)
	}
	withRand, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, key.Public(), key)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(withNil, withRand) {
		t.Fatal("the certificate depends on the randomness source")
	}
}

// Byte equality holds only under a pinned toolchain: Go's compatibility promise
// does not cover crypto/x509's extension order or DER layout.
func TestDeterminismScope(t *testing.T) {
	a := mint(t, "2d85dabefa504eefea7740977b1f9110daf404cc24422896a209b41eca970218")

	// A failure means a toolchain bump changed crypto/x509's DER output. The
	// transcript's recorded Go version tells a verifier which output applies.
	for _, tc := range []struct{ name, der, want string }{
		{"root", string(a.rootDER), "1444dc58af29362e9580f88695dae3fe9ebd0f166fb73d5a9f75a5a34b77119d"},
		{"intermediate", string(a.intDER), "968abc141cd7520de0c7d5605a5fe29fe42fd9b847d001ea79a3225dd0b051eb"},
	} {
		sum := sha256.Sum256([]byte(tc.der))
		if got := hex.EncodeToString(sum[:]); got != tc.want {
			t.Errorf("%s DER SHA-256 is %s under Go %s, pinned at %s", tc.name, got, runtime.Version(), tc.want)
		}
	}

	var got []string
	for _, e := range a.rootCert.Extensions {
		got = append(got, e.Id.String())
	}
	want := []string{
		"2.5.29.15", // keyUsage
		"2.5.29.19", // basicConstraints
		"2.5.29.14", // subjectKeyIdentifier
	}
	if len(got) != len(want) {
		t.Fatalf("Go %s emits %v, this test was written against %v", runtime.Version(), got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("Go %s emits %v, this test was written against %v", runtime.Version(), got, want)
		}
	}
}

func TestSerialProperties(t *testing.T) {
	seen := map[string]string{}
	for _, master := range []string{
		"0000000000000000000000000000000000000000000000000000000000000000",
		"000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
		"2d85dabefa504eefea7740977b1f9110daf404cc24422896a209b41eca970218",
	} {
		seed, err := hex.DecodeString(master)
		if err != nil {
			t.Fatal(err)
		}
		for _, d := range derive.V1Tree {
			if d.Type != derive.KeyEd25519 {
				continue
			}
			m, err := derive.MintFromMaster(seed, d.Path)
			if err != nil {
				t.Fatal(err)
			}
			pub := m.Ed25519.Public().(ed25519.PublicKey)
			sn, err := Serial(pub, d.Path)
			if err != nil {
				t.Fatal(err)
			}
			if sn.Sign() <= 0 {
				t.Errorf("%s under %s: serial is not positive", d.Path, master[:8])
			}
			encoded, err := asn1.Marshal(sn)
			if err != nil {
				t.Fatal(err)
			}
			// Minus the tag and length octets. RFC 5280 caps the value, leading
			// zero octet included, at 20.
			if n := len(encoded) - 2; n > 20 {
				t.Errorf("%s: serial encodes to %d octets", d.Path, n)
			}
			key := sn.String()
			if prev, ok := seen[key]; ok {
				t.Errorf("serial collision between %s and %s/%s", prev, master[:8], d.Path)
			}
			seen[key] = master[:8] + "/" + d.Path
		}
	}
	// One key at two paths needs two serials: RFC 5280 forbids reusing a serial
	// under one issuer.
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	a, err := Serial(pub, "fml/infra/v1/pki/root/v1")
	if err != nil {
		t.Fatal(err)
	}
	b, err := Serial(pub, "fml/infra/v1/pki/root/v2")
	if err != nil {
		t.Fatal(err)
	}
	if a.Cmp(b) == 0 {
		t.Error("the path does not separate serials")
	}
}

func TestChainLinks(t *testing.T) {
	a := mint(t, "2d85dabefa504eefea7740977b1f9110daf404cc24422896a209b41eca970218")

	if err := a.intCert.CheckSignatureFrom(a.rootCert); err != nil {
		t.Fatalf("the intermediate is not signed by the root: %v", err)
	}
	if err := a.rootCert.CheckSignatureFrom(a.rootCert); err != nil {
		t.Fatalf("the root is not self-signed: %v", err)
	}
	if !bytes.Equal(a.intCert.AuthorityKeyId, a.rootCert.SubjectKeyId) {
		t.Error("the intermediate's authorityKeyIdentifier does not name the new root")
	}
	if bytes.Equal(a.rootCert.SubjectKeyId, a.intCert.SubjectKeyId) {
		t.Error("the two anchors share a subject key identifier")
	}
	if !a.rootCert.IsCA || !a.intCert.IsCA {
		t.Error("an anchor is not a CA")
	}
	if a.rootCert.MaxPathLen != 2 || a.intCert.MaxPathLen != 1 {
		t.Errorf("pathLen root=%d intermediate=%d, want 2 and 1", a.rootCert.MaxPathLen, a.intCert.MaxPathLen)
	}
	if !a.rootCert.NotAfter.Equal(NoExpiry) || !a.rootCert.NotBefore.Equal(notBefore) {
		t.Errorf("the root's validity is %s..%s", a.rootCert.NotBefore, a.rootCert.NotAfter)
	}

	// Only the root is trusted, so the cluster CA must chain through the
	// intermediate to it.
	_, clusterKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	clusterDER, err := SignedBy(clusterKey, Profile{
		Path:       "fml/infra/v1/pki/cluster-folly/v1",
		RawSubject: subject(t, "FML K8s folly CA"),
		MaxPathLen: 0,
		NotBefore:  notBefore,
		NotAfter:   notBefore.AddDate(2, 0, 0),
	}, a.intCert, a.intKey)
	if err != nil {
		t.Fatal(err)
	}
	cluster, err := x509.ParseCertificate(clusterDER)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(a.rootCert)
	inter := x509.NewCertPool()
	inter.AddCert(a.intCert)
	if _, err := cluster.Verify(x509.VerifyOptions{
		Roots:         roots,
		Intermediates: inter,
		CurrentTime:   notBefore.AddDate(0, 1, 0),
		KeyUsages:     []x509.ExtKeyUsage{x509.ExtKeyUsageAny},
	}); err != nil {
		t.Fatalf("a cluster CA does not verify under the new anchors: %v", err)
	}
}

func TestProfileRejection(t *testing.T) {
	key := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{1}, 32))
	good := Profile{
		Path:       "fml/infra/v1/pki/root/v1",
		RawSubject: subject(t, "Folly Mountain Laboratories Root CA"),
		MaxPathLen: 2,
		NotBefore:  notBefore,
		NotAfter:   NoExpiry,
	}
	for name, p := range map[string]Profile{
		"no subject":        {Path: good.Path, NotBefore: notBefore, NotAfter: NoExpiry},
		"no notBefore":      {Path: good.Path, RawSubject: good.RawSubject, NotAfter: NoExpiry},
		"no notAfter":       {Path: good.Path, RawSubject: good.RawSubject, NotBefore: notBefore},
		"inverted validity": {Path: good.Path, RawSubject: good.RawSubject, NotBefore: NoExpiry, NotAfter: notBefore},
	} {
		if _, err := SelfSigned(key, p); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if _, err := SelfSigned(key, good); err != nil {
		t.Fatalf("a complete profile was refused: %v", err)
	}
}
