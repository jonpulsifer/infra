package bmc

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestLoadCredential(t *testing.T) {
	dir := t.TempDir()
	for name, c := range map[string]struct {
		body string
		ok   bool
	}{
		"whole":       {`{"username":"admin","password":"p:a ss"}`, true},
		"no password": {`{"username":"admin"}`, false},
		"user:pass":   {"admin:secret\n", false},
	} {
		path := filepath.Join(dir, strings.ReplaceAll(name, " ", "-"))
		if err := os.WriteFile(path, []byte(c.body), 0o600); err != nil {
			t.Fatal(err)
		}
		got, err := LoadCredential(path)
		if (err == nil) != c.ok {
			t.Errorf("%s: err %v", name, err)
		}
		if err != nil && strings.Contains(err.Error(), "secret") {
			t.Errorf("%s: the error repeats the file: %v", name, err)
		}
		if c.ok && got.Password != "p:a ss" {
			t.Errorf("%s: password %q", name, got.Password)
		}
	}
}

func TestDialerRefusesWhatItCannotDrive(t *testing.T) {
	d := &Dialer{Credentials: map[string]Credential{"amt": {"admin", "x"}, "ipmi": {"admin", "x"}}, AMTPort: 16992}
	if _, err := d.Dial("redfish", "10.0.0.1"); err == nil || !strings.Contains(err.Error(), "no credential") {
		t.Errorf("a type without a credential: %v", err)
	}
	if _, err := d.Dial("ipmi", "10.0.0.1"); err == nil || !strings.Contains(err.Error(), "no native driver") {
		t.Errorf("a type without a driver: %v", err)
	}
	if _, err := d.Dial("amt", ""); err == nil {
		t.Error("a BMC without an address dialed")
	}
	a, err := d.Dial("amt", "10.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	if b, _ := d.Dial("amt", "10.0.0.1"); b != a {
		t.Error("a second dial made a second client")
	}
}

// The AMT driver speaks plain HTTP to /wsman on the port it is given, with
// digest auth as the credential's user.
func TestAMTSpeaksDigestOverHTTP(t *testing.T) {
	var mu sync.Mutex
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.Method+" "+r.URL.Path+" "+r.Header.Get("Authorization"))
		mu.Unlock()
		w.Header().Set("WWW-Authenticate", `Digest realm="Digest:A3829B3827DE4D33D4449B366831FD01", nonce="abc", stale="false", qop="auth"`)
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()
	host, port, err := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	p, _ := strconv.Atoi(port)
	a := NewAMT(host, p, Credential{"admin", "x"}, 5*time.Second)
	if _, err := a.Power(t.Context()); err == nil {
		t.Fatal("a BMC that refuses every request answered")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(seen) < 2 || !strings.HasPrefix(seen[0], "POST /wsman ") {
		t.Fatalf("requests %q", seen)
	}
	if auth := seen[1]; !strings.Contains(auth, `Digest username="admin"`) || strings.Contains(auth, `"x"`) {
		t.Errorf("the call's auth is %q", auth)
	}
}

// A power-off whose power read fails is an error, not a machine taken for
// off: the provider alone would send nothing and answer success.
func TestAMTPowerOffFailsWhenThePowerReadFails(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "" {
			w.Header().Set("WWW-Authenticate", `Digest realm="Digest:A3829B3827DE4D33D4449B366831FD01", nonce="abc", stale="false", qop="auth"`)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		http.Error(w, "busy", http.StatusInternalServerError)
	}))
	defer srv.Close()
	host, port, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	p, _ := strconv.Atoi(port)
	a := NewAMT(host, p, Credential{"admin", "x"}, 5*time.Second)
	if err := a.PowerOff(t.Context()); err == nil || !strings.Contains(err.Error(), "read the power state") {
		t.Fatalf("power-off: %v", err)
	}
	if err := a.PowerOn(t.Context()); err == nil {
		t.Fatal("a power-on with a failed read answered")
	}
}

// An error keeps its cause through the one-line form, so a caller can tell
// a cancelled call from a BMC that refused.
func TestOneLineKeepsTheCause(t *testing.T) {
	err := oneLine(fmt.Errorf("post:\n\t%w", context.Canceled))
	if !errors.Is(err, context.Canceled) || strings.Contains(err.Error(), "\n") {
		t.Fatalf("%q", err)
	}
}
