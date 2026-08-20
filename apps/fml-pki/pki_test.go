package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// mintCA builds a CA the way a careless tool might, so the checks have
// something real to reject. parent nil means self-signed.
func mintCA(t *testing.T, cn string, maxPathLen int, pathLenSet bool, notAfter time.Time,
	parent *x509.Certificate, parentKey ed25519.PrivateKey) (*x509.Certificate, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(time.Now().UnixNano()),
		Subject:               pkix.Name{CommonName: cn},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              notAfter,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLen:            maxPathLen,
		MaxPathLenZero:        pathLenSet && maxPathLen == 0,
	}
	if !pathLenSet {
		tmpl.MaxPathLen = 0
		tmpl.MaxPathLenZero = false
	}
	signee, signer := tmpl, priv
	if parent != nil {
		signee, signer = parent, parentKey
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, signee, pub, signer)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return cert, priv
}

func TestPathLenDistinguishesZeroFromUnset(t *testing.T) {
	far := time.Now().AddDate(10, 0, 0)
	zero, _ := mintCA(t, "zero", 0, true, far, nil, nil)
	unset, _ := mintCA(t, "unset", 0, false, far, nil, nil)

	if n, ok := pathLen(zero); !ok || n != 0 {
		t.Errorf("pathLen:0 read as (%d, %t), want (0, true)", n, ok)
	}
	if _, ok := pathLen(unset); ok {
		t.Error("absent pathLen read as present — this is the ambiguity that hid the defect")
	}
}

func TestCheckChainAcceptsAWellFormedHierarchy(t *testing.T) {
	far := time.Now().AddDate(50, 0, 0)
	root, rootKey := mintCA(t, "root", 2, true, far, nil, nil)
	inter, interKey := mintCA(t, "intermediate", 1, true, far, root, rootKey)
	leafCA, _ := mintCA(t, "cluster", 0, false, time.Now().AddDate(2, 0, 0), inter, interKey)

	chain := []named{{leafCA, "cluster-ca.pem"}, {inter, "fml-intermediate.pem"}, {root, "fml-root.pem"}}
	if problems := checkChain("t", chain); len(problems) != 0 {
		t.Errorf("expected a clean chain, got %v", problems)
	}
}

func TestCheckChainRejectsTooTightPathLen(t *testing.T) {
	far := time.Now().AddDate(50, 0, 0)
	// The real defect: root pathLen:1 and intermediate pathLen:0 over a chain
	// that puts two CAs below the root and one below the intermediate.
	root, rootKey := mintCA(t, "root", 1, true, far, nil, nil)
	inter, interKey := mintCA(t, "intermediate", 0, true, far, root, rootKey)
	leafCA, _ := mintCA(t, "cluster", 0, false, time.Now().AddDate(2, 0, 0), inter, interKey)

	problems := checkChain("t", []named{{leafCA, "cluster-ca.pem"}, {inter, "int.pem"}, {root, "root.pem"}})
	joined := strings.Join(problems, "\n")
	if !strings.Contains(joined, "int.pem carries pathLen=0 but signs 1 CA(s)") {
		t.Errorf("intermediate violation not reported: %v", problems)
	}
	if !strings.Contains(joined, "root.pem carries pathLen=1 but signs 2 CA(s)") {
		t.Errorf("root violation not reported: %v", problems)
	}
}

func TestCheckChainRejectsNonSelfSignedAnchor(t *testing.T) {
	far := time.Now().AddDate(50, 0, 0)
	root, rootKey := mintCA(t, "root", 2, true, far, nil, nil)
	inter, interKey := mintCA(t, "intermediate", 1, true, far, root, rootKey)
	leafCA, _ := mintCA(t, "cluster", 0, false, far.AddDate(-40, 0, 0), inter, interKey)

	// Anchoring on the intermediate is what Kubernetes publishes today.
	problems := checkChain("t", []named{{leafCA, "cluster-ca.pem"}, {inter, "int.pem"}})
	if !strings.Contains(strings.Join(problems, "\n"), "is not self-signed") {
		t.Errorf("non-self-signed anchor not reported: %v", problems)
	}
}

func TestCheckChainRejectsAnIssuerThatExpiresFirst(t *testing.T) {
	root, rootKey := mintCA(t, "root", 2, true, time.Now().AddDate(50, 0, 0), nil, nil)
	inter, interKey := mintCA(t, "intermediate", 1, true, time.Now().AddDate(1, 0, 0), root, rootKey)
	leafCA, _ := mintCA(t, "cluster", 0, false, time.Now().AddDate(2, 0, 0), inter, interKey)

	problems := checkChain("t", []named{{leafCA, "cluster-ca.pem"}, {inter, "int.pem"}, {root, "root.pem"}})
	if !strings.Contains(strings.Join(problems, "\n"), "which it signed") {
		t.Errorf("expiry inversion not reported: %v", problems)
	}
}

// TestReissuePreservesIdentity guards the property the whole ceremony rests on:
// the replacements have to be interchangeable with what is already distributed.
func TestReissuePreservesIdentity(t *testing.T) {
	dir := t.TempDir()
	far := time.Now().AddDate(10, 0, 0)
	oldRoot, oldRootKey := mintCA(t, "Test Root CA", 1, true, far, nil, nil)
	oldInt, oldIntKey := mintCA(t, "Test Intermediate CA", 0, true, far, oldRoot, oldRootKey)
	clusterCA, _ := mintCA(t, "Test Cluster CA", 0, false, time.Now().AddDate(2, 0, 0), oldInt, oldIntKey)

	write := func(name string, der []byte) {
		if err := writePEM(filepath.Join(dir, name), "CERTIFICATE", der, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("fml-root.pem", oldRoot.Raw)
	write("fml-intermediate.pem", oldInt.Raw)
	write("cluster-ca.pem", clusterCA.Raw)

	writeKey := func(name string, k ed25519.PrivateKey) string {
		der, err := x509.MarshalPKCS8PrivateKey(k)
		if err != nil {
			t.Fatal(err)
		}
		p := filepath.Join(dir, name)
		if err := writePEM(p, "PRIVATE KEY", der, 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}

	var out bytes.Buffer
	err := runReissue(reissueOpts{
		certsDir:       dir,
		rootKeyPath:    writeKey("root.key", oldRootKey),
		intKeyPath:     writeKey("int.key", oldIntKey),
		rootNotAfter:   noExpiry,
		intNotAfter:    noExpiry,
		rootPathLen:    2,
		intPathLen:     1,
		stagingDirName: "staging",
	}, &out)
	if err != nil {
		t.Fatalf("reissue: %v\n%s", err, out.String())
	}

	newRoot, err := readCert(filepath.Join(dir, "staging", "fml-root.pem"))
	if err != nil {
		t.Fatal(err)
	}
	newInt, err := readCert(filepath.Join(dir, "staging", "fml-intermediate.pem"))
	if err != nil {
		t.Fatal(err)
	}

	for _, c := range []struct {
		label     string
		old, next *x509.Certificate
		want      int
	}{
		{"root", oldRoot, newRoot, 2},
		{"intermediate", oldInt, newInt, 1},
	} {
		if !bytes.Equal(c.old.RawSubject, c.next.RawSubject) {
			t.Errorf("%s: subject changed", c.label)
		}
		// Existing certificates name their issuer by this value.
		if !bytes.Equal(c.old.SubjectKeyId, c.next.SubjectKeyId) {
			t.Errorf("%s: subjectKeyId changed, so anything already issued cannot find its issuer", c.label)
		}
		if n, ok := pathLen(c.next); !ok || n != c.want {
			t.Errorf("%s: pathLen (%d, %t), want (%d, true)", c.label, n, ok, c.want)
		}
		if !c.next.NotAfter.Equal(noExpiry) {
			t.Errorf("%s: notAfter %s, want %s", c.label, c.next.NotAfter, noExpiry)
		}
	}

	// The point of the exercise: the untouched cluster CA now chains through.
	roots := x509.NewCertPool()
	roots.AddCert(newRoot)
	inter := x509.NewCertPool()
	inter.AddCert(newInt)
	if _, err := clusterCA.Verify(x509.VerifyOptions{
		Roots: roots, Intermediates: inter,
		KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageAny},
	}); err != nil {
		t.Errorf("existing cluster CA does not verify against the reissued anchors: %v", err)
	}
}

func TestReissueRefusesAMismatchedKey(t *testing.T) {
	dir := t.TempDir()
	far := time.Now().AddDate(10, 0, 0)
	oldRoot, oldRootKey := mintCA(t, "Root", 1, true, far, nil, nil)
	oldInt, _ := mintCA(t, "Intermediate", 0, true, far, oldRoot, oldRootKey)
	if err := writePEM(filepath.Join(dir, "fml-root.pem"), "CERTIFICATE", oldRoot.Raw, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := writePEM(filepath.Join(dir, "fml-intermediate.pem"), "CERTIFICATE", oldInt.Raw, 0o644); err != nil {
		t.Fatal(err)
	}
	_, stranger, _ := ed25519.GenerateKey(rand.Reader)
	der, _ := x509.MarshalPKCS8PrivateKey(stranger)
	strangerPath := filepath.Join(dir, "stranger.key")
	if err := writePEM(strangerPath, "PRIVATE KEY", der, 0o600); err != nil {
		t.Fatal(err)
	}
	rootDER, _ := x509.MarshalPKCS8PrivateKey(oldRootKey)
	rootPath := filepath.Join(dir, "root.key")
	if err := writePEM(rootPath, "PRIVATE KEY", rootDER, 0o600); err != nil {
		t.Fatal(err)
	}

	var out bytes.Buffer
	err := runReissue(reissueOpts{
		certsDir: dir, rootKeyPath: rootPath, intKeyPath: strangerPath,
		rootNotAfter: noExpiry, intNotAfter: noExpiry,
		rootPathLen: 2, intPathLen: 1, stagingDirName: "staging",
	}, &out)
	if err == nil || !strings.Contains(err.Error(), "intermediate key does not match") {
		t.Errorf("expected a key mismatch to stop the ceremony, got %v", err)
	}
}

// TestJWKSKidMatchesApiserverDerivation pins the one value that cannot drift:
// base64url(SHA256(DER SPKI)), which is how kube-apiserver labels the tokens it
// mints. A different kid means every token fails to resolve.
func TestJWKSKidMatchesApiserverDerivation(t *testing.T) {
	dir := t.TempDir()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "signer"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().AddDate(1, 0, 0),
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	certPath := filepath.Join(dir, "signer.pem")
	if err := writePEM(certPath, "CERTIFICATE", der, 0o644); err != nil {
		t.Fatal(err)
	}

	var errOut bytes.Buffer
	if err := runJWKS("https://oidc.example/cluster/", dir, []string{certPath}, &errOut); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "jwks.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc jwksDoc
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Keys) != 1 {
		t.Fatalf("got %d keys, want 1", len(doc.Keys))
	}
	want, err := spkiSHA256(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	if doc.Keys[0].Kid != b64url(want[:]) {
		t.Errorf("kid %q, want %q", doc.Keys[0].Kid, b64url(want[:]))
	}

	discovery, err := os.ReadFile(filepath.Join(dir, "openid-configuration.json"))
	if err != nil {
		t.Fatal(err)
	}
	// The trailing slash on the issuer must not survive into the documents.
	if !bytes.Contains(discovery, []byte(`"issuer": "https://oidc.example/cluster"`)) {
		t.Errorf("issuer not normalised: %s", discovery)
	}
}

func TestExponentBytes(t *testing.T) {
	for _, tc := range []struct {
		in   int
		want []byte
	}{
		{65537, []byte{0x01, 0x00, 0x01}},
		{3, []byte{0x03}},
		{0, []byte{0x00}},
	} {
		if got := exponentBytes(tc.in); !bytes.Equal(got, tc.want) {
			t.Errorf("exponentBytes(%d) = %x, want %x", tc.in, got, tc.want)
		}
	}
}

func TestReadCertRejectsABundle(t *testing.T) {
	dir := t.TempDir()
	far := time.Now().AddDate(10, 0, 0)
	a, aKey := mintCA(t, "a", 1, true, far, nil, nil)
	b, _ := mintCA(t, "b", 0, true, far, a, aKey)
	path := filepath.Join(dir, "bundle.pem")
	if err := os.WriteFile(path, append(pemBytes(t, a.Raw), pemBytes(t, b.Raw)...), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := readCert(path); err == nil || !strings.Contains(err.Error(), "expected one certificate") {
		t.Errorf("a bundle where an anchor belongs should be an error, got %v", err)
	}
}

func pemBytes(t *testing.T, der []byte) []byte {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, "x.pem")
	if err := writePEM(p, "CERTIFICATE", der, 0o644); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
