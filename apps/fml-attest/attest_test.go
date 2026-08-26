package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"strings"
	"testing"

	"github.com/jonpulsifer/infra/apps/fml-ceremony/jcs"
)

// fixture is written by apps/fml-ceremony's transcript tests. Reading the same
// file from both sides is what stops the writer and this independent reader
// from drifting apart while each keeps passing its own tests.
const fixture = "../fml-ceremony/testdata/transcript.example.json"

func TestFixtureVerifies(t *testing.T) {
	raw, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := verify(&out, fixture, raw); err != nil {
		t.Fatalf("%v\n%s", err, out.String())
	}
	for _, want := range []string{"OK  every check", "ASSERTED, NOT VERIFIED", "ssh-keygen -Y verify"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("output is missing %q:\n%s", want, out.String())
		}
	}
	if strings.Contains(out.String(), "FAIL") {
		t.Errorf("a check failed on the fixture:\n%s", out.String())
	}
}

// TestTampering is the point of the tool: every one of these is a transcript
// that reads plausibly and must not pass. Each case rebuilds the hash chain
// after editing, so nothing here is caught merely because the chain broke --
// except the case that is meant to be.
func TestTampering(t *testing.T) {
	cases := []struct {
		name string
		want string
		edit func(t *testing.T, doc map[string]any, entries []map[string]any) ([]map[string]any, bool)
	}{
		{
			name: "a ceremony abandoned before it closed",
			want: "abandoned ceremony",
			edit: func(_ *testing.T, _ map[string]any, e []map[string]any) ([]map[string]any, bool) {
				return e[:len(e)-1], true
			},
		},
		{
			name: "a quorum of one",
			want: "not a survivable quorum",
			edit: func(_ *testing.T, _ map[string]any, e []map[string]any) ([]map[string]any, bool) {
				body(e, "shards", 0)["threshold"] = 1.0
				return e, true
			},
		},
		{
			name: "a key minted under a reserved branch",
			want: "reserved branch",
			edit: func(_ *testing.T, _ map[string]any, e []map[string]any) ([]map[string]any, bool) {
				body(e, "leaf", 0)["path"] = "fml/kms/v1/pki/root/v1"
				return e, true
			},
		},
		{
			// The fixture publishes no digest at all -- it carries no entropy
			// and says so -- so this case has to introduce the violation it
			// tests rather than lean on the fixture already committing it.
			name: "a witness digest for a source that cannot afford one",
			want: "below the 128-bit floor",
			edit: func(_ *testing.T, _ map[string]any, e []map[string]any) ([]map[string]any, bool) {
				src := body(e, "entropy", 0)["sources"].([]any)
				src[0].(map[string]any)["min_entropy_bits"] = 20.0
				src[0].(map[string]any)["witness_sha256"] = strings.Repeat("ab", 32)
				return e, true
			},
		},
		{
			name: "a certificate swapped for another",
			want: "certificate hashes to",
			edit: func(_ *testing.T, _ map[string]any, e []map[string]any) ([]map[string]any, bool) {
				b := body(e, "certificate", 0)
				der := b["der"].(string)
				b["der"] = der[:len(der)-8] + "AAAAAAA="
				return e, true
			},
		},
		{
			name: "a certificate for a key the transcript never declared",
			want: "no leaf entry declares",
			edit: func(_ *testing.T, _ map[string]any, e []map[string]any) ([]map[string]any, bool) {
				body(e, "certificate", 0)["key_path"] = "fml/infra/v1/pki/other/v1"
				return e, true
			},
		},
		{
			// The reserved-name list only covers the two branches someone thought
			// of in advance. This branch is well-formed, unreserved, and has no
			// share set -- so anything derived under it dies with the master.
			name: "a key minted under a branch with no share set",
			want: "no share set",
			edit: func(_ *testing.T, _ map[string]any, e []map[string]any) ([]map[string]any, bool) {
				body(e, "leaf", 0)["path"] = "fml/attacker/v1/pki/root/v1"
				return e, true
			},
		},
		{
			name: "a published key edited after the fact",
			want: "links to",
			edit: func(_ *testing.T, _ map[string]any, e []map[string]any) ([]map[string]any, bool) {
				body(e, "leaf", 0)["public"] = strings.Repeat("ab", 32)
				return e, false
			},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			doc, entries := load(t)
			entries, rechain := c.edit(t, doc, entries)
			raw := assemble(t, doc, entries, rechain)
			var out bytes.Buffer
			if err := verify(&out, "tampered", raw); err == nil {
				t.Fatalf("tampered transcript passed:\n%s", out.String())
			}
			if !strings.Contains(out.String(), c.want) {
				t.Fatalf("failure did not mention %q:\n%s", c.want, out.String())
			}
		})
	}
}

func TestTrailingNewlineIsNotCanonical(t *testing.T) {
	raw, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := verify(&out, fixture, append(raw, '\n')); err == nil {
		t.Fatal("a transcript with a trailing newline passed")
	}
	if !strings.Contains(out.String(), "trailing whitespace") {
		t.Fatalf("the failure did not name the cause:\n%s", out.String())
	}
}

func TestUnknownFieldIsRefused(t *testing.T) {
	doc, entries := load(t)
	doc["surprise"] = "a field nobody reviewed"
	raw := assemble(t, doc, entries, true)
	if err := verify(io.Discard, "tampered", raw); err == nil {
		t.Fatal("a transcript with an undeclared field passed")
	}
}

func load(t *testing.T) (map[string]any, []map[string]any) {
	t.Helper()
	raw, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	var entries []map[string]any
	for _, e := range doc["entries"].([]any) {
		entries = append(entries, e.(map[string]any))
	}
	delete(doc, "entries")
	return doc, entries
}

// body returns the nth body of a given step, so a case can name what it is
// corrupting instead of counting entries.
func body(entries []map[string]any, step string, n int) map[string]any {
	for _, e := range entries {
		if e["step"] == step {
			if n == 0 {
				return e["body"].(map[string]any)
			}
			n--
		}
	}
	panic("no such step: " + step)
}

// assemble rebuilds the document. With rechain set it recomputes seq and prev,
// so an edit is caught by the check it targets rather than by the chain; the
// one case that leaves it unset is testing the chain itself.
func assemble(t *testing.T, doc map[string]any, entries []map[string]any, rechain bool) []byte {
	t.Helper()
	prev := genesis
	raws := make([]json.RawMessage, 0, len(entries))
	for i, e := range entries {
		if rechain {
			e["seq"] = float64(i)
			e["prev"] = prev
		}
		raw, err := json.Marshal(e)
		if err != nil {
			t.Fatal(err)
		}
		c, err := jcs.Canonical(raw)
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(c)
		prev = hex.EncodeToString(sum[:])
		raws = append(raws, c)
	}
	doc["entries"] = raws
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	c, err := jcs.Canonical(raw)
	if err != nil {
		t.Fatal(err)
	}
	return c
}
