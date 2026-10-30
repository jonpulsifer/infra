package main

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"encoding/pem"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const (
	testNode   = "riptide"
	testSerial = "66BT7M2"
	agentConf  = `agent {
  data_dir = "@DATA_DIR@"
}
plugins {
  @NODE_ATTESTOR@
  KeyManager "disk" {
    plugin_data {
      directory = "@DATA_DIR@"
    }
  }
}
`
	ekConf    = "NodeAttestor \"tpm\" {\n  plugin_data {}\n}\n"
	devidConf = "NodeAttestor \"tpm_devid\" {\n  plugin_data {}\n}\n"
)

var now = time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)

type ca struct {
	cert *x509.Certificate
	key  crypto.Signer
}

func newCA(t *testing.T) ca {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "folly-devid-ca"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, key.Public(), key)
	if err != nil {
		t.Fatal(err)
	}
	c, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return ca{cert: c, key: key}
}

type leaf struct {
	cn, serial string
	notAfter   time.Time
	pub        crypto.PublicKey
}

func (c ca) issue(t *testing.T, l leaf) string {
	t.Helper()
	if l.notAfter.IsZero() {
		l.notAfter = now.Add(time.Hour)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: l.cn, SerialNumber: l.serial},
		NotBefore:    now.Add(-time.Hour),
		NotAfter:     l.notAfter,
		KeyUsage:     x509.KeyUsageDigitalSignature,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, c.cert, l.pub, c.key)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})) +
		string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: c.cert.Raw}))
}

func u16(v int) []byte { return binary.BigEndian.AppendUint16(nil, uint16(v)) }

func sized(b []byte) []byte { return append(u16(len(b)), b...) }

// tpmtPublic encodes a key the way the TPM returns it from TPM2_Create.
func tpmtPublic(t *testing.T, key crypto.PublicKey, attrs uint32) []byte {
	t.Helper()
	var b []byte
	head := func(typ int) {
		b = append(b, u16(typ)...)
		b = append(b, u16(0x000b)...) // nameAlg SHA-256
		b = binary.BigEndian.AppendUint32(b, attrs)
		b = append(b, sized(nil)...)   // authPolicy
		b = append(b, u16(algNull)...) // symmetric
	}
	switch k := key.(type) {
	case *rsa.PublicKey:
		head(algRSA)
		b = append(b, u16(0x0014)...) // RSASSA
		b = append(b, u16(0x000b)...)
		b = append(b, u16(k.N.BitLen())...)
		b = binary.BigEndian.AppendUint32(b, 0)
		b = append(b, sized(k.N.Bytes())...)
	case *ecdsa.PublicKey:
		head(algECC)
		b = append(b, u16(0x0018)...) // ECDSA
		b = append(b, u16(0x000b)...)
		b = append(b, u16(curveP256)...)
		b = append(b, u16(algNull)...) // kdf
		point, err := k.Bytes()
		if err != nil {
			t.Fatal(err)
		}
		b = append(b, sized(point[1:33])...)
		b = append(b, sized(point[33:])...)
	default:
		t.Fatalf("no encoding for %T", key)
	}
	return b
}

func rsaKey(t *testing.T) *rsa.PrivateKey {
	t.Helper()
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

type fixture struct {
	t       *testing.T
	dir     string
	opts    options
	answer  func(w http.ResponseWriter)
	queries atomic.Int32
	path    atomic.Value
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	dir := t.TempDir()
	f := &fixture{t: t, dir: dir}
	for name, body := range map[string]string{
		"config/agent.conf":     agentConf,
		"config/tpm.conf":       ekConf,
		"config/tpm_devid.conf": devidConf,
		"serial":                testSerial + "\n",
	} {
		p := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, d := range []string{"devid", "agent"} {
		if err := os.Mkdir(filepath.Join(dir, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.queries.Add(1)
		f.path.Store(r.URL.Path)
		f.answer(w)
	}))
	t.Cleanup(srv.Close)
	f.opts = options{
		attestURL: srv.URL,
		nodeName:  testNode,
		serial:    filepath.Join(dir, "serial"),
		configDir: filepath.Join(dir, "config"),
		devidDir:  filepath.Join(dir, "devid"),
		dataDir:   "/var/lib/spire-agent",
		out:       filepath.Join(dir, "agent", "agent.conf"),
		attempts:  2,
		client:    srv.Client(),
		now:       func() time.Time { return now },
	}
	return f
}

func (f *fixture) serve(d DevID) {
	f.answer = func(w http.ResponseWriter) { _ = json.NewEncoder(w).Encode(d) }
}

func (f *fixture) run() (string, string) {
	f.t.Helper()
	attestor, err := run(context.Background(), slog.New(slog.NewTextHandler(io.Discard, nil)), f.opts)
	if err != nil {
		f.t.Fatalf("run: %v", err)
	}
	conf, err := os.ReadFile(f.opts.out)
	if err != nil {
		f.t.Fatal(err)
	}
	return attestor, string(conf)
}

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

func TestNoAttestURLRendersTheEKAttestor(t *testing.T) {
	f := newFixture(t)
	f.opts.attestURL = ""
	attestor, conf := f.run()
	if attestor != attestorEK {
		t.Fatalf("attestor = %s, want tpm", attestor)
	}
	if !strings.Contains(conf, `NodeAttestor "tpm" {`) || strings.Contains(conf, "tpm_devid") {
		t.Fatalf("config does not hold only the EK attestor:\n%s", conf)
	}
	if strings.Count(conf, `"/var/lib/spire-agent"`) != 2 || strings.Contains(conf, "@") {
		t.Fatalf("data dir not rendered:\n%s", conf)
	}
	if f.queries.Load() != 0 {
		t.Fatal("queried the attest service with no ATTEST_URL")
	}
}

func TestLDevIDRendersTheDevIDAttestor(t *testing.T) {
	rsaPriv := rsaKey(t)
	ecPriv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name string
		key  crypto.PublicKey
		// TPM2B prefixes the size, as tpm2_create writes it; SPIRE wants it bare.
		prefixed bool
	}{
		{"rsa", &rsaPriv.PublicKey, false},
		{"rsa with TPM2B sizes", &rsaPriv.PublicKey, true},
		{"ecc", &ecPriv.PublicKey, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t)
			ca := newCA(t)
			pub := tpmtPublic(t, tc.key, attrSign)
			priv := append(sized(make([]byte, 32)), []byte("wrapped sensitive")...)
			wirePub, wirePriv := pub, priv
			if tc.prefixed {
				wirePub, wirePriv = sized(pub), sized(priv)
			}
			f.serve(DevID{
				CertPEM: ca.issue(t, leaf{cn: testNode, serial: testSerial, pub: tc.key}),
				PubB64:  b64(wirePub),
				PrivB64: b64(wirePriv),
			})
			attestor, conf := f.run()
			if attestor != attestorDevID {
				t.Fatalf("attestor = %s, want tpm_devid", attestor)
			}
			if got := f.path.Load(); got != "/devid/"+testSerial {
				t.Fatalf("path = %v", got)
			}
			if !strings.Contains(conf, `NodeAttestor "tpm_devid" {`) || strings.Contains(conf, `NodeAttestor "tpm" {`) {
				t.Fatalf("config does not hold only the DevID attestor:\n%s", conf)
			}
			if strings.Count(conf, `"/var/lib/spire-agent/tpm_devid"`) != 2 {
				t.Fatalf("the DevID agent does not keep its own data dir:\n%s", conf)
			}
			for name, want := range map[string][]byte{pubFile: pub, privFile: priv} {
				got, err := os.ReadFile(filepath.Join(f.opts.devidDir, name))
				if err != nil {
					t.Fatal(err)
				}
				if string(got) != string(want) {
					t.Fatalf("%s is not the bare blob", name)
				}
			}
			chain, err := os.ReadFile(filepath.Join(f.opts.devidDir, certFile))
			if err != nil {
				t.Fatal(err)
			}
			if strings.Count(string(chain), "BEGIN CERTIFICATE") != 2 {
				t.Fatalf("%s does not hold the leaf and its CA", certFile)
			}
		})
	}
}

func TestUnusableLDevIDFallsBackToTheEKAttestor(t *testing.T) {
	key := rsaKey(t)
	other := rsaKey(t)
	good := func(t *testing.T) DevID {
		return DevID{
			CertPEM: newCA(t).issue(t, leaf{cn: testNode, serial: testSerial, pub: &key.PublicKey}),
			PubB64:  b64(tpmtPublic(t, &key.PublicKey, attrSign)),
			PrivB64: b64([]byte("private")),
		}
	}
	for _, tc := range []struct {
		name    string
		answer  func(t *testing.T, w http.ResponseWriter)
		queries int32
	}{
		{"not attested", func(_ *testing.T, w http.ResponseWriter) { w.WriteHeader(http.StatusNotFound) }, 1},
		{"server error is retried", func(_ *testing.T, w http.ResponseWriter) { w.WriteHeader(http.StatusBadGateway) }, 2},
		{"not json", func(_ *testing.T, w http.ResponseWriter) { _, _ = w.Write([]byte("<html>")) }, 2},
		{"another node's CN", func(t *testing.T, w http.ResponseWriter) {
			d := good(t)
			d.CertPEM = newCA(t).issue(t, leaf{cn: "optiplex", serial: testSerial, pub: &key.PublicKey})
			_ = json.NewEncoder(w).Encode(d)
		}, 1},
		{"another machine's serial", func(t *testing.T, w http.ResponseWriter) {
			d := good(t)
			d.CertPEM = newCA(t).issue(t, leaf{cn: testNode, serial: "OTHER", pub: &key.PublicKey})
			_ = json.NewEncoder(w).Encode(d)
		}, 1},
		{"expired", func(t *testing.T, w http.ResponseWriter) {
			d := good(t)
			d.CertPEM = newCA(t).issue(t, leaf{cn: testNode, serial: testSerial, pub: &key.PublicKey, notAfter: now.Add(-time.Minute)})
			_ = json.NewEncoder(w).Encode(d)
		}, 1},
		{"certificate for another key", func(t *testing.T, w http.ResponseWriter) {
			d := good(t)
			d.PubB64 = b64(tpmtPublic(t, &other.PublicKey, attrSign))
			_ = json.NewEncoder(w).Encode(d)
		}, 1},
		{"key cannot sign", func(t *testing.T, w http.ResponseWriter) {
			d := good(t)
			d.PubB64 = b64(tpmtPublic(t, &key.PublicKey, 0))
			_ = json.NewEncoder(w).Encode(d)
		}, 1},
		{"truncated public blob", func(t *testing.T, w http.ResponseWriter) {
			d := good(t)
			d.PubB64 = b64(tpmtPublic(t, &key.PublicKey, attrSign)[:40])
			_ = json.NewEncoder(w).Encode(d)
		}, 1},
		{"no private blob", func(t *testing.T, w http.ResponseWriter) {
			d := good(t)
			d.PrivB64 = ""
			_ = json.NewEncoder(w).Encode(d)
		}, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t)
			f.answer = func(w http.ResponseWriter) { tc.answer(t, w) }
			attestor, conf := f.run()
			if attestor != attestorEK || !strings.Contains(conf, `NodeAttestor "tpm" {`) {
				t.Fatalf("attestor = %s, want the EK fallback", attestor)
			}
			if got := f.queries.Load(); got != tc.queries {
				t.Fatalf("queries = %d, want %d", got, tc.queries)
			}
			if entries, _ := os.ReadDir(f.opts.devidDir); len(entries) != 0 {
				t.Fatalf("wrote LDevID files for an unusable LDevID: %v", entries)
			}
		})
	}
}

func TestEmptySerialFallsBack(t *testing.T) {
	f := newFixture(t)
	if err := os.WriteFile(f.opts.serial, []byte(" \n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if attestor, _ := f.run(); attestor != attestorEK {
		t.Fatalf("attestor = %s, want tpm", attestor)
	}
	if f.queries.Load() != 0 {
		t.Fatal("queried the attest service with an empty serial")
	}
}

func TestRenderRefusesATemplateWithoutPlaceholders(t *testing.T) {
	f := newFixture(t)
	if err := os.WriteFile(filepath.Join(f.opts.configDir, "agent.conf"), []byte("agent {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	f.opts.attestURL = ""
	_, err := run(context.Background(), slog.New(slog.NewTextHandler(io.Discard, nil)), f.opts)
	if err == nil {
		t.Fatal("rendered a config with no node attestor")
	}
}
