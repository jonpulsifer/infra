package pkcs11signer

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"io"
	"math/big"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/eclipse-keypont/crypto11"
	"github.com/miekg/pkcs11"
)

const (
	tokenLabel = "devid-ca-test"
	userPIN    = "12345678"
	soPIN      = "87654321"
)

// softHSM finds libsofthsm2.so. CI sets PKCS11SIGNER_REQUIRE_SOFTHSM so a missing module fails there.
func softHSM(t *testing.T) string {
	t.Helper()
	candidates := []string{os.Getenv("SOFTHSM2_MODULE")}
	if bin, err := exec.LookPath("softhsm2-util"); err == nil {
		candidates = append(candidates, filepath.Join(filepath.Dir(filepath.Dir(bin)), "lib", "softhsm", "libsofthsm2.so"))
	}
	candidates = append(candidates, "/usr/lib/softhsm/libsofthsm2.so", "/usr/lib/x86_64-linux-gnu/softhsm/libsofthsm2.so")
	for _, c := range candidates {
		if c == "" {
			continue
		}
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	if os.Getenv("PKCS11SIGNER_REQUIRE_SOFTHSM") != "" {
		t.Fatal("libsofthsm2.so not found; set SOFTHSM2_MODULE")
	}
	t.Skip("libsofthsm2.so not found; set SOFTHSM2_MODULE")
	return ""
}

// newToken initializes an empty SoftHSM token in a temporary directory.
func newToken(t *testing.T, module string) {
	t.Helper()
	dir := t.TempDir()
	conf := filepath.Join(dir, "softhsm2.conf")
	tokens := filepath.Join(dir, "tokens")
	if err := os.Mkdir(tokens, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(conf, []byte("directories.tokendir = "+tokens+"\nobjectstore.backend = file\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SOFTHSM2_CONF", conf)

	p := pkcs11.New(module)
	if p == nil {
		t.Fatalf("cannot load %s", module)
	}
	defer p.Destroy()
	must(t, p.Initialize())
	defer func() { _ = p.Finalize() }()
	slots, err := p.GetSlotList(false)
	must(t, err)
	must(t, p.InitToken(slots[0], soPIN, tokenLabel))

	slots, err = p.GetSlotList(true)
	must(t, err)
	var slot uint
	found := false
	for _, s := range slots {
		info, err := p.GetTokenInfo(s)
		must(t, err)
		if strings.TrimSpace(info.Label) == tokenLabel {
			slot, found = s, true
		}
	}
	if !found {
		t.Fatal("initialized token not found")
	}
	sess, err := p.OpenSession(slot, pkcs11.CKF_SERIAL_SESSION|pkcs11.CKF_RW_SESSION)
	must(t, err)
	must(t, p.Login(sess, pkcs11.CKU_SO, soPIN))
	must(t, p.InitPIN(sess, userPIN))
	must(t, p.Logout(sess))
	must(t, p.CloseSession(sess))
}

// newCA generates an RSA-2048 key on the token and certifies it as a CA under a software root.
func newCA(t *testing.T, module string) (ca, root *x509.Certificate) {
	t.Helper()
	ctx, err := crypto11.Configure(&crypto11.Config{Path: module, TokenLabel: tokenLabel, Pin: userPIN})
	must(t, err)
	defer func() { _ = ctx.Close() }()
	key, err := ctx.GenerateRSAKeyPairWithLabel([]byte{2}, []byte("devid-ca"), 2048)
	must(t, err)
	// A second key pair on the token must not be picked.
	_, err = ctx.GenerateRSAKeyPairWithLabel([]byte{3}, []byte("other"), 2048)
	must(t, err)

	rootKey, err := rsa.GenerateKey(rand.Reader, 2048)
	must(t, err)
	root = selfSigned(t, rootKey, "test root")
	ca = issue(t, root, rootKey, key.Public(), &x509.Certificate{
		Subject:               pkix.Name{CommonName: "folly-devid-ca-test"},
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
	})
	return ca, root
}

func TestSignerIssuesAVerifiableCertificate(t *testing.T) {
	module := softHSM(t)
	newToken(t, module)
	ca, root := newCA(t, module)

	s, err := Open(Config{Module: module, Token: tokenLabel, PIN: userPIN, Cert: ca})
	must(t, err)
	defer func() { _ = s.Close() }()

	leaf := issueWith(t, ca, s)
	roots := x509.NewCertPool()
	roots.AddCert(root)
	inter := x509.NewCertPool()
	inter.AddCert(ca)
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: roots, Intermediates: inter, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageAny}}); err != nil {
		t.Fatalf("leaf does not verify: %v", err)
	}
}

func TestFromEnv(t *testing.T) {
	module := softHSM(t)
	newToken(t, module)
	ca, root := newCA(t, module)

	dir := t.TempDir()
	pinFile := filepath.Join(dir, "pin")
	must(t, os.WriteFile(pinFile, []byte(userPIN+"\n"), 0o600))
	chain := filepath.Join(dir, "chain.pem")
	must(t, os.WriteFile(chain, append(pemCert(ca), pemCert(root)...), 0o644))

	t.Setenv(EnvModule, module)
	t.Setenv(EnvToken, tokenLabel)
	t.Setenv(EnvPINFile, pinFile)
	t.Setenv(EnvCert, chain)
	if !Configured() {
		t.Fatal("Configured() is false with the module set")
	}
	s, err := FromEnv()
	must(t, err)
	defer func() { _ = s.Close() }()
	if !s.Certificate().Equal(ca) {
		t.Fatal("FromEnv did not take the first certificate of the chain file")
	}
	issueWith(t, ca, s)
}

func TestFromEnvNamesEveryUnsetVariable(t *testing.T) {
	for _, v := range []string{EnvModule, EnvToken, EnvPINFile, EnvCert} {
		t.Setenv(v, "")
	}
	_, err := FromEnv()
	if err == nil {
		t.Fatal("FromEnv succeeded with nothing set")
	}
	for _, v := range []string{EnvModule, EnvToken, EnvPINFile, EnvCert} {
		if !strings.Contains(err.Error(), v) {
			t.Errorf("error %q does not name %s", err, v)
		}
	}
}

func TestOpenRefusesACertificateWithNoKeyOnTheToken(t *testing.T) {
	module := softHSM(t)
	newToken(t, module)
	newCA(t, module)
	rootKey, err := rsa.GenerateKey(rand.Reader, 2048)
	must(t, err)
	stranger := selfSigned(t, rootKey, "stranger")

	_, err = Open(Config{Module: module, Token: tokenLabel, PIN: userPIN, Cert: stranger})
	if err == nil || !strings.Contains(err.Error(), "no key pair matches") {
		t.Fatalf("Open with a foreign certificate: %v", err)
	}
}

func TestOpenRefusesANonCACertificate(t *testing.T) {
	module := softHSM(t)
	newToken(t, module)
	ca, _ := newCA(t, module)
	leaf := *ca
	leaf.IsCA = false
	_, err := Open(Config{Module: module, Token: tokenLabel, PIN: userPIN, Cert: &leaf})
	if err == nil || !strings.Contains(err.Error(), "may not sign certificates") {
		t.Fatalf("Open with a leaf: %v", err)
	}
}

func TestOpenRefusesAWrongPIN(t *testing.T) {
	module := softHSM(t)
	newToken(t, module)
	ca, _ := newCA(t, module)
	if _, err := Open(Config{Module: module, Token: tokenLabel, PIN: "00000000", Cert: ca}); err == nil {
		t.Fatal("Open succeeded with a wrong PIN")
	}
}

func TestOpenRefusesAnUnknownToken(t *testing.T) {
	module := softHSM(t)
	newToken(t, module)
	ca, _ := newCA(t, module)
	if _, err := Open(Config{Module: module, Token: "absent", PIN: userPIN, Cert: ca}); err == nil {
		t.Fatal("Open succeeded with an unknown token label")
	}
}

func TestSignReopensALostSession(t *testing.T) {
	module := softHSM(t)
	newToken(t, module)
	ca, _ := newCA(t, module)
	s, err := Open(Config{Module: module, Token: tokenLabel, PIN: userPIN, Cert: ca})
	must(t, err)
	defer func() { _ = s.Close() }()

	// A key whose signatures fail, as a card that lost its login after a reset.
	s.mu.Lock()
	s.key = lostLogin{s.key}
	s.mu.Unlock()

	issueWith(t, ca, s)
	if s.gen != 1 {
		t.Fatalf("generation %d after one reopen, want 1", s.gen)
	}
}

func TestSignAfterCloseFails(t *testing.T) {
	module := softHSM(t)
	newToken(t, module)
	ca, _ := newCA(t, module)
	s, err := Open(Config{Module: module, Token: tokenLabel, PIN: userPIN, Cert: ca})
	must(t, err)
	must(t, s.Close())
	digest := make([]byte, 32)
	if _, err := s.Sign(rand.Reader, digest, crypto.SHA256); err == nil {
		t.Fatal("Sign succeeded after Close")
	}
}

type lostLogin struct{ crypto.Signer }

func (lostLogin) Sign(io.Reader, []byte, crypto.SignerOpts) ([]byte, error) {
	return nil, pkcs11.Error(pkcs11.CKR_USER_NOT_LOGGED_IN)
}

func issueWith(t *testing.T, ca *x509.Certificate, signer crypto.Signer) *x509.Certificate {
	t.Helper()
	leafKey, err := rsa.GenerateKey(rand.Reader, 2048)
	must(t, err)
	return issue(t, ca, signer, &leafKey.PublicKey, &x509.Certificate{
		Subject:  pkix.Name{CommonName: "riptide"},
		KeyUsage: x509.KeyUsageDigitalSignature,
	})
}

func selfSigned(t *testing.T, key *rsa.PrivateKey, cn string) *x509.Certificate {
	t.Helper()
	return issue(t, nil, key, &key.PublicKey, &x509.Certificate{
		Subject:               pkix.Name{CommonName: cn},
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	})
}

func issue(t *testing.T, parent *x509.Certificate, signer crypto.Signer, pub crypto.PublicKey, tmpl *x509.Certificate) *x509.Certificate {
	t.Helper()
	serial, err := rand.Int(rand.Reader, big.NewInt(1<<62))
	must(t, err)
	tmpl.SerialNumber = serial
	tmpl.NotBefore = time.Now().Add(-time.Minute)
	tmpl.NotAfter = time.Now().Add(time.Hour)
	if parent == nil {
		parent = tmpl
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, parent, pub, signer)
	must(t, err)
	cert, err := x509.ParseCertificate(der)
	must(t, err)
	return cert
}

func pemCert(c *x509.Certificate) []byte {
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: c.Raw})
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
