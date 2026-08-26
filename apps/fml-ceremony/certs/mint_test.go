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

// notBefore is pinned from the ceremony's declared start, never from the clock.
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

// mint runs the whole anchor half of the ceremony from a master seed: derive
// both Ed25519 leaves, self-sign the root, sign the intermediate under it.
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
	// pathLen 2 on the root and 1 on the intermediate: two CAs follow the root
	// and one follows the intermediate. An anchor holding less than the chain
	// requires forbids the chain it signs.
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

// TestMintIsBitIdentical is the property the whole design rests on: the same
// master seed, minted twice, produces the same certificate octet for octet.
//
// It is available only because the anchors are Ed25519 — RFC 8032 signatures
// are deterministic, unlike ECDSA's or a PSS RSA's. The scope of the claim is
// stated honestly in TestDeterminismScope below.
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
	// A different master must produce different anchors, or the test above
	// would pass on a constant.
	c := mint(t, "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
	if bytes.Equal(a.rootDER, c.rootDER) {
		t.Fatal("two different masters minted the same root")
	}
}

// TestSignatureIgnoresRandomness proves the reproducibility rather than
// asserting it: mint once with a reader that refuses to produce a byte, and
// once with the real CSPRNG. Identical output means no randomness reached the
// certificate, which is stronger than minting twice the same way.
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

// TestDeterminismScope records what "identical" is actually true of, so nobody
// reads the test above as a promise about the year 2046.
//
// Deterministic, forever: the derivation, the key, the serial, the subject key
// identifier, the timestamps. Those are all computed in this repository from
// pinned inputs.
//
// Not promised by anything: the order crypto/x509 emits extensions in, and the
// exact DER it builds around them. That order is whatever the emitting code in
// crypto/x509 does, no specification pins it, and Go's compatibility promise
// does not cover it. So the honest claim is "bit-identical under a pinned
// toolchain", not "bit-identical in twenty years" — which is why the ceremony
// transcript records the Go version, and why the certificate's own SHA-256 is
// recorded rather than a promise to recompute it.
func TestDeterminismScope(t *testing.T) {
	a := mint(t, "2d85dabefa504eefea7740977b1f9110daf404cc24422896a209b41eca970218")

	// The pinned-toolchain claim, made operational. These are the SHA-256s of
	// the two anchors minted from that master under the Go this test last
	// passed on. If a toolchain bump changes how crypto/x509 builds DER, this
	// fails here, on a PR, instead of at a ceremony where a certificate was
	// supposed to come out identical to one minted years earlier.
	//
	// A failure is not necessarily a defect. It means the byte-equality claim
	// now holds only within a toolchain range, and the transcript's recorded Go
	// version is what tells a future verifier which range they are in.
	for _, tc := range []struct{ name, der, want string }{
		{"root", string(a.rootDER), "1444dc58af29362e9580f88695dae3fe9ebd0f166fb73d5a9f75a5a34b77119d"},
		{"intermediate", string(a.intDER), "968abc141cd7520de0c7d5605a5fe29fe42fd9b847d001ea79a3225dd0b051eb"},
	} {
		sum := sha256.Sum256([]byte(tc.der))
		if got := hex.EncodeToString(sum[:]); got != tc.want {
			t.Errorf("%s DER SHA-256 is %s under Go %s, pinned at %s", tc.name, got, runtime.Version(), tc.want)
		}
	}

	// The extensions Go emits, in the order it emits them. A change here is
	// exactly the kind of toolchain drift that would break byte-equality with
	// a certificate minted under an older Go, and it should fail this test
	// rather than surface during a re-birth.
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

// TestSerialProperties is ticket 07's checklist: positive, at most 20 octets
// encoded, and unique across every key in the tree.
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
			// DER encodes a positive INTEGER with a leading zero octet when
			// the high bit is set, so the encoded length can be one more than
			// the value length. RFC 5280 caps it at 20.
			encoded, err := asn1.Marshal(sn)
			if err != nil {
				t.Fatal(err)
			}
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
	// Same key, different path: the path is in the derivation, so the serials
	// must differ. Without that a leaf reissued at a new path would reuse a
	// serial, which RFC 5280 forbids for one issuer.
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

// TestChainLinks asserts the minted pair is usable: the intermediate is signed
// by the root, both are CAs, the identifiers link, and pathLen admits a cluster
// CA and a leaf beneath it.
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
	// A re-birth mints new keys, so the identifiers necessarily change. That is
	// the opposite of apps/fml-pki's reissue path, which carries the previous
	// SubjectKeyId precisely so already-issued certificates still find their
	// issuer. Everything issued under the old anchors keeps pointing at the old
	// identifier and must be reissued; nothing here can paper over that.
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

	// A cluster CA issued under the new intermediate must build a full path to
	// the new root, which is what an OpenSSL client does and a Go client does
	// not: Go anchors on whatever is in the trust store and never walks up.
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
