package main

import (
	"crypto/x509"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLoadCAChoosesTheSigner(t *testing.T) {
	ca := devIDCA(t)
	dir := t.TempDir()
	keyDER, err := x509.MarshalPKCS8PrivateKey(ca.key)
	if err != nil {
		t.Fatal(err)
	}
	key, chain := filepath.Join(dir, "key.pem"), filepath.Join(dir, "chain.pem")
	writePEM(t, key, "PRIVATE KEY", keyDER)
	if err := os.WriteFile(chain, ca.ChainPEM(), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, v := range []string{"ATTEST_CA_KEY", "ATTEST_CA_PKCS11_MODULE", "ATTEST_CA_PKCS11_TOKEN", "ATTEST_CA_PKCS11_PIN_FILE", "ATTEST_CA_CERT"} {
		t.Setenv(v, "")
	}

	if _, err := loadCA(chain, time.Hour); err == nil || !strings.Contains(err.Error(), "ATTEST_CA_PKCS11_MODULE") {
		t.Errorf("no key and no token should name both, got %v", err)
	}

	t.Setenv("ATTEST_CA_KEY", key)
	got, err := loadCA(chain, time.Hour)
	if err != nil {
		t.Fatalf("the software key should load: %v", err)
	}
	if !got.Cert.Equal(ca.Cert) {
		t.Error("the software key loaded another CA")
	}

	// A configured token wins over the software key, so a broken token never falls back silently.
	t.Setenv("ATTEST_CA_PKCS11_MODULE", filepath.Join(dir, "absent.so"))
	if !pkcs11Configured() {
		t.Fatal("ATTEST_CA_PKCS11_MODULE should select the token")
	}
	if _, err := loadCA(chain, time.Hour); err == nil {
		t.Error("a configured but unusable token should fail, not fall back to the software key")
	}
}
