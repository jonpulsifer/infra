package fleet

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeAPI is the cluster's API as the account sees it: Secrets in
// kube-system, which it may create and delete but not update, as the API server
// stores them, keyed by name.
type fakeAPI struct {
	mu      sync.Mutex
	secrets map[string]map[string]any
	calls   []string
	down    bool
}

func (f *fakeAPI) server(t *testing.T) *Cluster {
	t.Helper()
	s := httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(s.Close)
	return &Cluster{Server: s.URL, Token: "sa-token", Client: s.Client()}
}

func (f *fakeAPI) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.down {
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
		return
	}
	if r.Header.Get("Authorization") != "Bearer sa-token" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	f.calls = append(f.calls, r.Method+" "+r.URL.Path)
	if f.secrets == nil {
		f.secrets = map[string]map[string]any{}
	}
	const base = "/api/v1/namespaces/kube-system/secrets"
	var body map[string]any
	if r.Body != nil {
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
	}
	switch name, named := strings.CutPrefix(r.URL.Path, base+"/"); {
	case r.Method == http.MethodPost && r.URL.Path == base:
		n := body["metadata"].(map[string]any)["name"].(string)
		if _, ok := f.secrets[n]; ok {
			http.Error(w, "already exists", http.StatusConflict)
			return
		}
		f.secrets[n] = body
	case r.Method == http.MethodDelete && named:
		if _, ok := f.secrets[name]; !ok {
			http.NotFound(w, r)
			return
		}
		delete(f.secrets, name)
	default:
		http.Error(w, "unexpected "+r.Method+" "+r.URL.Path, http.StatusBadRequest)
		return
	}
	w.Write([]byte("{}"))
}

func (f *fakeAPI) secret(name string) map[string]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	s, ok := f.secrets[name]
	if !ok {
		return nil
	}
	out := map[string]string{"type": s["type"].(string)}
	for k, v := range s["metadata"].(map[string]any)["labels"].(map[string]any) {
		out["label "+k] = v.(string)
	}
	for k, v := range s["stringData"].(map[string]any) {
		out[k] = v.(string)
	}
	return out
}

func TestJoinTokenIDIsStableAndPerNode(t *testing.T) {
	ids := map[string]bool{}
	for _, n := range []string{"riptide", "swell", "surge", "shale", "optiplex"} {
		id := JoinTokenID(n)
		if id != JoinTokenID(n) || len(id) != 6 || strings.Trim(id, "0123456789abcdefghijklmnopqrstuvwxyz") != "" {
			t.Fatalf("%s: id %q", n, id)
		}
		ids[id] = true
	}
	if len(ids) != 5 {
		t.Fatalf("two nodes share a token ID: %v", ids)
	}
}

// A mint creates the node's one token Secret in the shape the admission
// policy admits; a second mint, here or from a fresh client as after a
// restart, replaces it, so the node never has two live tokens and the old
// one stops working.
func TestMintKeepsOneTokenPerNode(t *testing.T) {
	api := &fakeAPI{}
	c := api.server(t)
	expires := testNow.Add(6 * time.Hour)
	first, err := c.Mint(t.Context(), "riptide", expires)
	if err != nil {
		t.Fatal(err)
	}
	id := JoinTokenID("riptide")
	if !joinTokenPattern.MatchString(first) || !strings.HasPrefix(first, id+".") {
		t.Fatalf("token %q", first)
	}
	got := api.secret("bootstrap-token-" + id)
	want := map[string]string{
		"type":                           "bootstrap.kubernetes.io/token",
		"label lolwtf.ca/managed-by":     "fleet-controller",
		"label lolwtf.ca/node":           "riptide",
		"token-id":                       id,
		"token-secret":                   strings.TrimPrefix(first, id+"."),
		"expiration":                     expires.UTC().Format(time.RFC3339),
		"usage-bootstrap-authentication": "true",
		"auth-extra-groups":              "system:bootstrappers:nodes",
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %q, want %q", k, got[k], v)
		}
	}
	if _, signs := got["usage-bootstrap-signing"]; signs {
		t.Error("the token may sign")
	}

	restarted := &Cluster{Server: c.Server, Token: c.Token, Client: c.Client}
	second, err := restarted.Mint(t.Context(), "riptide", expires.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if second == first || !strings.HasPrefix(second, id+".") {
		t.Fatalf("the second token %q, the first %q", second, first)
	}
	if len(api.secrets) != 1 || api.secret("bootstrap-token-" + id)["token-secret"] != strings.TrimPrefix(second, id+".") {
		t.Fatalf("secrets %v", api.secrets)
	}
	if _, err := c.Mint(t.Context(), "swell", expires); err != nil || len(api.secrets) != 2 {
		t.Fatalf("another node's token: %v, %d secrets", err, len(api.secrets))
	}
	wantCalls := []string{"POST", "POST", "DELETE", "POST", "POST"}
	if len(api.calls) != len(wantCalls) {
		t.Fatalf("calls %v", api.calls)
	}
	for i, call := range api.calls {
		if !strings.HasPrefix(call, wantCalls[i]+" ") {
			t.Fatalf("calls %v", api.calls)
		}
	}
}

func TestMintFailsWhenTheAPIDoesNotAnswer(t *testing.T) {
	api := &fakeAPI{down: true}
	if _, err := api.server(t).Mint(t.Context(), "riptide", testNow); err == nil {
		t.Fatal("a mint against an API that answers 503 succeeded")
	}
}

// A worker's render carries the token minted for it, valid for the config's
// TTL and the grace; a control plane mints none; a failed mint renders
// nothing; and without the cluster's API no worker renders.
func TestWorkerRenderCarriesItsOwnToken(t *testing.T) {
	it := newInstallTest(t, "planned", nil)
	if code, reason := it.render(goodRequest()); code != 201 {
		t.Fatalf("%d %s", code, reason)
	}
	wantExpiry := testNow.Add(2*time.Hour + JoinTokenGrace).UTC().Format(time.RFC3339)
	if len(it.tokens.minted) != 1 || it.tokens.minted[0] != "riptide "+wantExpiry {
		t.Fatalf("minted %v", it.tokens.minted)
	}
	if len(it.rend.tokens) != 1 || !joinTokenPattern.MatchString(it.rend.tokens[0]) {
		t.Fatalf("rendered with %v", it.rend.tokens)
	}

	it = newInstallTest(t, "planned", nil)
	it.tokens.fail = errors.New("connection refused")
	if code, reason := it.render(goodRequest()); code != 503 || !strings.Contains(reason, "bootstrap token") || it.held(testCode) || it.rend.calls != 0 {
		t.Fatalf("a failed mint: %d %s", code, reason)
	}

	it = newInstallTest(t, "planned", nil)
	it.in.Tokens = nil
	if err := it.in.Ready(context.Background(), Device{Name: "riptide", Class: "worker-g5", TPM: "2.0"}); err == nil || status(err) != 503 {
		t.Fatalf("a worker is ready without the cluster's API: %v", err)
	}
	if code, _ := it.render(goodRequest()); code != 503 || it.rend.calls != 0 {
		t.Fatalf("a worker rendered without the cluster's API: %d", code)
	}

	it = newInstallTest(t, "planned", map[string]any{"talos_class": "controlplane"})
	it.in.ControlPlanes = true
	it.in.Bootstrap = "10.3.0.10"
	req := goodRequest()
	req.Class = "controlplane"
	if code, reason := it.render(req); code != 201 || len(it.tokens.minted) != 0 || it.rend.tokens[0] != "" {
		t.Fatalf("a control plane: %d %s, minted %v", code, reason, it.tokens.minted)
	}
}
