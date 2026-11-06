package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
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

// A nil parent means self-signed.
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
	// Too tight for two CAs below the root and one below the intermediate.
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

// Reissued anchors must be interchangeable with the ones already distributed.
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

	// The untouched cluster CA chains through the new anchors.
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

// kube-apiserver labels its tokens with base64url(SHA256(DER SPKI)); any other
// kid fails to resolve.
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

// Pods receive this file as ca.crt, and OpenSSL cannot anchor on a lone
// non-self-signed CA.
func TestChainFileMustBuildAPath(t *testing.T) {
	dir := t.TempDir()
	far := time.Now().AddDate(50, 0, 0)
	root, rootKey := mintCA(t, "root", 2, true, far, nil, nil)
	inter, interKey := mintCA(t, "intermediate", 1, true, far, root, rootKey)
	clusterCA, _ := mintCA(t, "cluster", 0, false, time.Now().AddDate(2, 0, 0), inter, interKey)

	full := filepath.Join(dir, "c-ca-chain.pem")
	if err := os.WriteFile(full, concat(t, clusterCA.Raw, inter.Raw, root.Raw), 0o644); err != nil {
		t.Fatal(err)
	}
	if problems := checkChainFile("c", full, clusterCA); len(problems) != 0 {
		t.Errorf("a complete chain should pass, got %v", problems)
	}

	lonely := filepath.Join(dir, "lonely-ca-chain.pem")
	if err := os.WriteFile(lonely, concat(t, clusterCA.Raw), 0o644); err != nil {
		t.Fatal(err)
	}
	problems := checkChainFile("c", lonely, clusterCA)
	if !strings.Contains(strings.Join(problems, "\n"), "cannot build a path out of it") {
		t.Errorf("a lone cluster CA should be rejected, got %v", problems)
	}

	// Truncated at the intermediate: linked, but not anchored on a self-signed root.
	truncated := filepath.Join(dir, "trunc-ca-chain.pem")
	if err := os.WriteFile(truncated, concat(t, clusterCA.Raw, inter.Raw), 0o644); err != nil {
		t.Fatal(err)
	}
	problems = checkChainFile("c", truncated, clusterCA)
	if !strings.Contains(strings.Join(problems, "\n"), "is not self-signed") {
		t.Errorf("a chain stopping at the intermediate should be rejected, got %v", problems)
	}

	// Wrong cluster's CA at the head.
	other, _ := mintCA(t, "other cluster", 0, false, time.Now().AddDate(2, 0, 0), inter, interKey)
	problems = checkChainFile("c", full, other)
	if !strings.Contains(strings.Join(problems, "\n"), "not the cluster CA it is published for") {
		t.Errorf("a mismatched head should be rejected, got %v", problems)
	}
}

func concat(t *testing.T, ders ...[]byte) []byte {
	t.Helper()
	var out []byte
	for _, d := range ders {
		out = append(out, pemBytes(t, d)...)
	}
	return out
}

// SPIRE trusts the bundle, so a DevID CA left out of it cannot vouch for its machines.
func TestVerifyChecksTheDevIDBundle(t *testing.T) {
	dir := t.TempDir()
	far := time.Now().AddDate(50, 0, 0)
	fiveYears := time.Now().AddDate(5, 0, 0)
	root, rootKey := mintCA(t, "root", 2, true, far, nil, nil)
	inter, interKey := mintCA(t, "issuing", 1, true, far, root, rootKey)
	capsule, _ := mintCA(t, "folly-devid-ca-capsule", 0, false, fiveYears, inter, interKey)
	spore, _ := mintCA(t, "folly-devid-ca-spore", 0, false, fiveYears, inter, interKey)
	write := func(name string, ders ...[]byte) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), concat(t, ders...), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("fml-root.pem", root.Raw)
	write("folly-issuing-ca.pem", inter.Raw)
	write("folly-devid-ca-capsule.pem", capsule.Raw)
	write("folly-devid-ca-spore.pem", spore.Raw)

	verify := func() string {
		t.Helper()
		var out, errOut bytes.Buffer
		_ = runVerify(dir, &out, &errOut)
		return errOut.String()
	}

	if got := verify(); !strings.Contains(got, "folly-devid-ca.pem is missing") {
		t.Errorf("a missing bundle should fail, got %q", got)
	}
	write("folly-devid-ca.pem", spore.Raw, capsule.Raw)
	if got := verify(); !strings.Contains(got, "not the 2 issuing DevID CA(s) in file-name order") {
		t.Errorf("a misordered bundle should fail, got %q", got)
	}
	write("folly-devid-ca.pem", capsule.Raw)
	if got := verify(); !strings.Contains(got, "not the 2 issuing DevID CA(s)") {
		t.Errorf("a bundle without spore should fail, got %q", got)
	}
	write("folly-devid-ca.pem", capsule.Raw, spore.Raw)
	if got := verify(); got != "" {
		t.Errorf("a complete bundle should pass, got %q", got)
	}

	// A chain file sits beside its CA and stays out of the bundle.
	write("folly-devid-ca-spore-chain.pem", spore.Raw, inter.Raw, root.Raw)
	if got := verify(); got != "" {
		t.Errorf("a CA's chain file should pass, got %q", got)
	}
	write("folly-devid-ca-spore-chain.pem", capsule.Raw, inter.Raw, root.Raw)
	if got := verify(); !strings.Contains(got, "not the cluster CA it is published for") {
		t.Errorf("a chain file that starts with another CA should fail, got %q", got)
	}
	if err := os.Remove(filepath.Join(dir, "folly-devid-ca-spore-chain.pem")); err != nil {
		t.Fatal(err)
	}
	write("folly-devid-ca-chain.pem", spore.Raw, inter.Raw, root.Raw)
	if got := verify(); !strings.Contains(got, "folly-devid-ca-chain.pem names no issuing CA") {
		t.Errorf("a chain file for the bundle should fail, got %q", got)
	}
	if err := os.Remove(filepath.Join(dir, "folly-devid-ca-chain.pem")); err != nil {
		t.Fatal(err)
	}

	// A CA signed under a former anchor stays trusted through its own chain file, and fails without one.
	oldRoot, oldRootKey := mintCA(t, "former root", 2, true, far, nil, nil)
	oldInter, oldInterKey := mintCA(t, "former intermediate", 1, true, far, oldRoot, oldRootKey)
	software, _ := mintCA(t, "folly-devid-ca-software", 0, false, fiveYears, oldInter, oldInterKey)
	write("folly-devid-ca-software.pem", software.Raw)
	write("folly-devid-ca.pem", capsule.Raw, software.Raw, spore.Raw)
	if got := verify(); !strings.Contains(got, "folly-devid-ca-software.pem is not under folly-issuing-ca.pem and has no folly-devid-ca-software-chain.pem") {
		t.Errorf("a legacy CA without a chain file should fail, got %q", got)
	}
	write("folly-devid-ca-software-chain.pem", software.Raw, oldInter.Raw, oldRoot.Raw)
	if got := verify(); got != "" {
		t.Errorf("a legacy CA with its chain file should pass, got %q", got)
	}

	stranger, strangerKey := mintCA(t, "stranger", 1, true, far, nil, nil)
	rogue, _ := mintCA(t, "folly-devid-ca-rogue", 0, false, fiveYears, stranger, strangerKey)
	write("folly-devid-ca-rogue.pem", rogue.Raw)
	write("folly-devid-ca.pem", capsule.Raw, rogue.Raw, spore.Raw)
	if got := verify(); !strings.Contains(got, "folly-devid-ca-rogue.pem is not under folly-issuing-ca.pem and has no folly-devid-ca-rogue-chain.pem") {
		t.Errorf("a DevID CA outside the chain should fail, got %q", got)
	}
}

func TestSignCASignsUnderTheRoot(t *testing.T) {
	far := time.Now().AddDate(20, 0, 0)
	root, rootKey := mintCA(t, "FML Root", 2, true, far, nil, nil)
	dir := t.TempDir()
	writeCertFile(t, filepath.Join(dir, "fml-root.pem"), root)
	der, err := x509.MarshalPKCS8PrivateKey(rootKey)
	if err != nil {
		t.Fatal(err)
	}
	keyPath := filepath.Join(dir, "root.key")
	if err := writePEM(keyPath, "PRIVATE KEY", der, 0o600); err != nil {
		t.Fatal(err)
	}

	csrKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	csrDER, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{
		Subject: pkix.Name{CommonName: "FML folly Issuing CA", Organization: []string{"Folly Mountain Laboratories"}},
	}, csrKey)
	if err != nil {
		t.Fatal(err)
	}
	csrPath := filepath.Join(dir, "issuing.csr")
	if err := writePEM(csrPath, "CERTIFICATE REQUEST", csrDER, 0o644); err != nil {
		t.Fatal(err)
	}

	outPath := filepath.Join(dir, "folly-issuing-ca.pem")
	var out bytes.Buffer
	notAfter := time.Now().AddDate(5, 0, 0)
	if err := runSignCA(signCAOpts{
		certsDir: dir, rootKeyPath: keyPath, csrPath: csrPath, outPath: outPath, pathLen: 1, notAfter: notAfter,
	}, &out); err != nil {
		t.Fatalf("sign-ca: %v", err)
	}
	cert, err := readCert(outPath)
	if err != nil {
		t.Fatal(err)
	}
	if !cert.IsCA || cert.MaxPathLen != 1 {
		t.Fatalf("got CA=%t pathLen=%d, want a CA with pathLen 1", cert.IsCA, cert.MaxPathLen)
	}
	if cert.Subject.CommonName != "FML folly Issuing CA" {
		t.Fatalf("subject %q does not come from the CSR", cert.Subject)
	}
	if !csrKey.PublicKey.Equal(cert.PublicKey) {
		t.Fatal("the certificate does not carry the CSR's key")
	}
	if err := cert.CheckSignatureFrom(root); err != nil {
		t.Fatalf("not signed by the root: %v", err)
	}
	if cert.NotAfter.Sub(notAfter).Abs() > time.Second {
		t.Fatalf("notAfter %s, want %s", cert.NotAfter, notAfter)
	}

	// verify reads the committed file as the issuing CA under the root.
	var vout, verr bytes.Buffer
	if err := runVerify(dir, &vout, &verr); err != nil {
		t.Fatalf("verify: %v\n%s", err, verr.String())
	}
	if !strings.Contains(vout.String(), "==> issuing") {
		t.Fatalf("verify did not report the issuing CA:\n%s", vout.String())
	}

	// A CSR the key cannot sign for is refused.
	otherRoot, _ := mintCA(t, "Other Root", 2, true, far, nil, nil)
	writeCertFile(t, filepath.Join(dir, "fml-root.pem"), otherRoot)
	if err := runSignCA(signCAOpts{
		certsDir: dir, rootKeyPath: keyPath, csrPath: csrPath, outPath: outPath, pathLen: 1, notAfter: notAfter,
	}, &out); err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("a mismatched root key was accepted: %v", err)
	}
}

func TestVerifyRejectsAnIssuingCAWithoutRoom(t *testing.T) {
	far := time.Now().AddDate(20, 0, 0)
	root, rootKey := mintCA(t, "FML Root", 2, true, far, nil, nil)
	issuing, _ := mintCA(t, "FML folly Issuing CA", 0, true, far, root, rootKey)
	dir := t.TempDir()
	writeCertFile(t, filepath.Join(dir, "fml-root.pem"), root)
	writeCertFile(t, filepath.Join(dir, "folly-issuing-ca.pem"), issuing)
	var out, errOut bytes.Buffer
	if err := runVerify(dir, &out, &errOut); err == nil || !strings.Contains(errOut.String(), "pathLen >= 1") {
		t.Fatalf("verify accepted an issuing CA with pathLen 0: %v\n%s", err, errOut.String())
	}
}

func writeCertFile(t *testing.T, path string, cert *x509.Certificate) {
	t.Helper()
	if err := writePEM(path, "CERTIFICATE", cert.Raw, 0o644); err != nil {
		t.Fatal(err)
	}
}
