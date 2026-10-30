package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jonpulsifer/infra/apps/fleetd/attest"
)

// The boot listener serves the device flow under /attest/ and the config at
// /talos/config, and nothing else.
func TestBootHandlerRoutes(t *testing.T) {
	srv := &attest.Server{V: &attest.Verifier{}, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	config := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		w.WriteHeader(http.StatusTeapot)
	})
	h := bootHandler(srv, config)
	for _, c := range []struct {
		method, path string
		want         int
	}{
		{http.MethodGet, "/attest/healthz", http.StatusOK},
		{http.MethodGet, "/healthz", http.StatusOK},
		{http.MethodGet, "/talos/config?uuid=x&code=y", http.StatusTeapot},
		{http.MethodHead, "/talos/config?uuid=x&code=y", http.StatusMethodNotAllowed},
		{http.MethodGet, "/devid/SERIAL", http.StatusNotFound},
		{http.MethodGet, "/v1/attest", http.StatusNotFound},
		{http.MethodGet, "/", http.StatusNotFound},
	} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(c.method, c.path, nil))
		if w.Code != c.want {
			t.Errorf("%s %s: %d, want %d", c.method, c.path, w.Code, c.want)
		}
	}
}

func writeCert(t *testing.T, dir, cn string) (string, string) {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: cn}, NotBefore: time.Now(), NotAfter: time.Now().Add(time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	kder, _ := x509.MarshalECPrivateKey(key)
	cert, keyPath := filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")
	_ = os.WriteFile(cert, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600)
	_ = os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kder}), 0o600)
	return cert, keyPath
}

// A renewed certificate is served once its file changes; a broken renewal
// keeps the one in hand.
func TestKeyPairFollowsARenewal(t *testing.T) {
	dir := t.TempDir()
	cert, key := writeCert(t, dir, "first")
	kp := &keyPair{cert: cert, key: key}
	c, err := kp.get(nil)
	if err != nil {
		t.Fatal(err)
	}
	first := c.Certificate[0]
	writeCert(t, dir, "second")
	later := time.Now().Add(time.Hour)
	_ = os.Chtimes(cert, later, later)
	kp.checked = time.Time{}
	if c, _ := kp.get(nil); string(c.Certificate[0]) == string(first) {
		t.Fatal("the renewed certificate was not served")
	}
	_ = os.WriteFile(cert, []byte("junk"), 0o600)
	_ = os.Chtimes(cert, later.Add(time.Hour), later.Add(time.Hour))
	kp.checked = time.Time{}
	if c, err := kp.get(nil); err != nil || c == nil {
		t.Fatalf("a broken renewal dropped the certificate: %v", err)
	}
}
