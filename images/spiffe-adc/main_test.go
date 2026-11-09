package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func envOf(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func fetchOK(_ context.Context, audience string) (string, time.Time, error) {
	return "svid-for-" + audience, time.Unix(1_800_000_000, 0), nil
}

func decode(t *testing.T, b []byte) response {
	t.Helper()
	var r response
	if err := json.Unmarshal(b, &r); err != nil {
		t.Fatalf("not one JSON object: %v: %q", err, b)
	}
	return r
}

func TestAnswersWithTheSVID(t *testing.T) {
	var out bytes.Buffer
	env := envOf(map[string]string{"GOOGLE_EXTERNAL_ACCOUNT_AUDIENCE": "//iam.googleapis.com/pool/providers/spire"})
	if err := run(context.Background(), env, fetchOK, &out); err != nil {
		t.Fatalf("run: %v", err)
	}
	want := response{Version: 1, Success: true, TokenType: tokenTypeJWT, IDToken: "svid-for-//iam.googleapis.com/pool/providers/spire", Expiration: 1_800_000_000}
	if got := decode(t, out.Bytes()); got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestEchoesTheRequestedTokenType(t *testing.T) {
	var out bytes.Buffer
	env := envOf(map[string]string{"GOOGLE_EXTERNAL_ACCOUNT_AUDIENCE": "aud", "GOOGLE_EXTERNAL_ACCOUNT_TOKEN_TYPE": tokenTypeIDToken})
	if err := run(context.Background(), env, fetchOK, &out); err != nil {
		t.Fatalf("run: %v", err)
	}
	if r := decode(t, out.Bytes()); r.TokenType != tokenTypeIDToken {
		t.Fatalf("token_type %q, want %q", r.TokenType, tokenTypeIDToken)
	}
}

func TestRefusesAnotherTokenType(t *testing.T) {
	var out bytes.Buffer
	env := envOf(map[string]string{"GOOGLE_EXTERNAL_ACCOUNT_AUDIENCE": "aud", "GOOGLE_EXTERNAL_ACCOUNT_TOKEN_TYPE": "urn:ietf:params:oauth:token-type:saml2"})
	if err := run(context.Background(), env, fetchOK, &out); err == nil {
		t.Fatal("run accepted a SAML token type")
	}
	if r := decode(t, out.Bytes()); r.Success || r.Code == "" || !strings.Contains(r.Message, "saml2") {
		t.Fatalf("failure reply %+v", r)
	}
}

func TestFailsWithoutAnAudience(t *testing.T) {
	var out bytes.Buffer
	if err := run(context.Background(), envOf(nil), fetchOK, &out); err == nil {
		t.Fatal("run answered with no audience")
	}
	if r := decode(t, out.Bytes()); r.Success || r.IDToken != "" {
		t.Fatalf("failure reply %+v", r)
	}
}

func TestReportsTheAgentError(t *testing.T) {
	var out bytes.Buffer
	fetch := func(context.Context, string) (string, time.Time, error) {
		return "", time.Time{}, errors.New("dial unix /spiffe-workload-api/agent.sock: no such file")
	}
	env := envOf(map[string]string{"GOOGLE_EXTERNAL_ACCOUNT_AUDIENCE": "aud"})
	if err := run(context.Background(), env, fetch, &out); err == nil {
		t.Fatal("run hid the agent error")
	}
	if r := decode(t, out.Bytes()); r.Success || !strings.Contains(r.Message, "agent.sock") {
		t.Fatalf("failure reply %+v", r)
	}
}

func TestWritesTheOutputFile(t *testing.T) {
	var out bytes.Buffer
	path := filepath.Join(t.TempDir(), "cache.json")
	env := envOf(map[string]string{"GOOGLE_EXTERNAL_ACCOUNT_AUDIENCE": "aud", "GOOGLE_EXTERNAL_ACCOUNT_OUTPUT_FILE": path})
	if err := run(context.Background(), env, fetchOK, &out); err != nil {
		t.Fatalf("run: %v", err)
	}
	cached, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if decode(t, cached) != decode(t, out.Bytes()) {
		t.Fatal("the output file differs from stdout")
	}
	if info, _ := os.Stat(path); info.Mode().Perm() != 0o600 {
		t.Fatalf("output file mode %v, want 0600", info.Mode().Perm())
	}
}
