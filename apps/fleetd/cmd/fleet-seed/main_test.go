package main

import (
	"context"
	"fmt"
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
	machine  = "4c4c4544-0042-3010-8051-b8c04f595a32"
	goodSeed = `{"version":1,"name":"shale","class":"nixos","profile":"general"}` + "\n"
)

type rig struct {
	s      *seeder
	dir    string
	host   string
	hits   atomic.Int32
	server *httptest.Server
}

func newRig(t *testing.T, esp func(url string) string, handler func(r *rig, w http.ResponseWriter, req *http.Request)) *rig {
	t.Helper()
	r := &rig{dir: t.TempDir()}
	r.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		r.hits.Add(1)
		handler(r, w, req)
	}))
	t.Cleanup(r.server.Close)
	write := func(name, body string) string {
		p := filepath.Join(r.dir, name)
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	state := filepath.Join(r.dir, "state")
	if err := os.Mkdir(state, 0o700); err != nil {
		t.Fatal(err)
	}
	r.s = &seeder{
		seedFile:   write("fleet-seed.json", esp(r.server.URL+"/seed")),
		stateDir:   state,
		uuidFile:   write("product_uuid", strings.ToUpper(machine)+"\n"),
		retries:    3,
		retryDelay: time.Millisecond,
		timeout:    time.Second,
		client:     r.server.Client(),
		setHost:    func(n string) error { r.host = n; return nil },
		logf:       t.Logf,
	}
	return r
}

func serveSeed(r *rig, w http.ResponseWriter, req *http.Request) {
	if req.URL.Path != "/seed" || req.URL.Query().Get("uuid") != machine || req.URL.Query().Get("code") != "abc123" {
		http.NotFound(w, req)
		return
	}
	fmt.Fprint(w, goodSeed)
}

func goodESP(url string) string {
	return fmt.Sprintf(`{"url":%q,"uuid":%q,"code":"abc123"}`, url, machine)
}

func TestValidSeedIsStoredAndNamesTheHost(t *testing.T) {
	r := newRig(t, goodESP, serveSeed)
	if err := r.s.run(context.Background()); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(r.s.stateDir, "seed.json")
	got, err := os.ReadFile(target)
	if err != nil || string(got) != goodSeed {
		t.Fatalf("stored %q, %v", got, err)
	}
	if fi, _ := os.Stat(target); fi.Mode().Perm() != 0o600 {
		t.Errorf("mode %v", fi.Mode().Perm())
	}
	if r.host != "shale" {
		t.Errorf("hostname %q", r.host)
	}
	if left, _ := filepath.Glob(filepath.Join(r.s.stateDir, "seed.*")); len(left) != 1 {
		t.Errorf("temporary files left: %v", left)
	}
	if _, err := os.Stat(r.s.seedFile); err != nil {
		t.Errorf("the ESP file was touched: %v", err)
	}
}

func TestSeedWithoutUUIDIsAccepted(t *testing.T) {
	r := newRig(t, func(u string) string { return fmt.Sprintf(`{"url":%q,"code":"abc123"}`, u) }, serveSeed)
	if err := r.s.run(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestUUIDMismatchFetchesNothing(t *testing.T) {
	r := newRig(t, func(u string) string {
		return fmt.Sprintf(`{"url":%q,"uuid":"00000000-0000-0000-0000-000000000000","code":"abc123"}`, u)
	}, serveSeed)
	err := r.s.run(context.Background())
	if err == nil || !strings.Contains(err.Error(), "this machine is "+machine) {
		t.Fatalf("err = %v", err)
	}
	if r.hits.Load() != 0 {
		t.Error("fleetd was asked with a code for another machine")
	}
}

func TestUnknownFieldIsRejected(t *testing.T) {
	r := newRig(t, func(u string) string {
		return fmt.Sprintf(`{"url":%q,"code":"abc123","hostname":"evil"}`, u)
	}, serveSeed)
	if err := r.s.run(context.Background()); err == nil || !strings.Contains(err.Error(), "hostname") {
		t.Fatalf("err = %v", err)
	}
	if r.hits.Load() != 0 {
		t.Error("fleetd was asked")
	}
}

func TestRerunIsANoOp(t *testing.T) {
	r := newRig(t, goodESP, serveSeed)
	if err := r.s.run(context.Background()); err != nil {
		t.Fatal(err)
	}
	r.host = ""
	if err := os.Remove(r.s.seedFile); err != nil {
		t.Fatal(err)
	}
	if err := r.s.run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if r.hits.Load() != 1 || r.host != "" {
		t.Errorf("second run fetched %d times and set host %q", r.hits.Load(), r.host)
	}
}

func TestMissingESPFileFails(t *testing.T) {
	r := newRig(t, goodESP, serveSeed)
	os.Remove(r.s.seedFile)
	if err := r.s.run(context.Background()); err == nil {
		t.Fatal("no error")
	}
}

func TestClientErrorIsFinal(t *testing.T) {
	r := newRig(t, goodESP, func(_ *rig, w http.ResponseWriter, req *http.Request) { http.NotFound(w, req) })
	if err := r.s.run(context.Background()); err == nil {
		t.Fatal("no error")
	}
	if r.hits.Load() != 1 {
		t.Errorf("%d fetches; the code burns on the first", r.hits.Load())
	}
	if _, err := os.Stat(filepath.Join(r.s.stateDir, "seed.json")); err == nil {
		t.Error("a seed was stored")
	}
}

func TestNetworkComingUpIsRetried(t *testing.T) {
	r := newRig(t, goodESP, func(r *rig, w http.ResponseWriter, req *http.Request) {
		if r.hits.Load() < 3 {
			http.Error(w, "starting", http.StatusServiceUnavailable)
			return
		}
		serveSeed(r, w, req)
	})
	if err := r.s.run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if r.hits.Load() != 3 || r.host != "shale" {
		t.Errorf("fetches %d, host %q", r.hits.Load(), r.host)
	}
}

func TestRetriesAreBounded(t *testing.T) {
	r := newRig(t, goodESP, func(_ *rig, w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "down", http.StatusServiceUnavailable)
	})
	if err := r.s.run(context.Background()); err == nil {
		t.Fatal("no error")
	}
	if r.hits.Load() != 4 {
		t.Errorf("%d attempts", r.hits.Load())
	}
}

func TestUnusableSeedIsNotStored(t *testing.T) {
	r := newRig(t, goodESP, func(_ *rig, w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, `{"version":2,"name":"x"}`) })
	if err := r.s.run(context.Background()); err == nil {
		t.Fatal("no error")
	}
	if _, err := os.Stat(filepath.Join(r.s.stateDir, "seed.json")); err == nil {
		t.Error("a seed was stored")
	}
}
