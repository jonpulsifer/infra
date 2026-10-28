package main

import (
	"context"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func TestListenUnixSocket(t *testing.T) {
	path := filepath.Join(t.TempDir(), "admin.sock")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}

	ln, err := listen("unix:"+path, 0o600)
	if err != nil {
		t.Fatalf("listen over a stale file: %v", err)
	}
	defer ln.Close()

	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&os.ModeSocket == 0 || info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v, want a socket with 0600", info.Mode())
	}

	go func() {
		_ = http.Serve(ln, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = io.WriteString(w, "ok")
		}))
	}()
	c := http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", path)
		},
	}}
	resp, err := c.Get("http://localhost/")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if body, _ := io.ReadAll(resp.Body); string(body) != "ok" {
		t.Fatalf("body = %q", body)
	}
}

func TestListenTCP(t *testing.T) {
	ln, err := listen("127.0.0.1:0", 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if ln.Addr().Network() != "tcp" {
		t.Fatalf("network = %s, want tcp", ln.Addr().Network())
	}
}
