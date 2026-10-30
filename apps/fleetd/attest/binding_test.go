package attest

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"
)

// An approved binding counts only when Terraform's user made its newest
// change; anything else is refused, journaled and records nothing.
func TestBindingCountsOnlyFromTerraform(t *testing.T) {
	h := strings.Repeat("ab", 32)
	for _, c := range []struct {
		name, refused  string
		writer, author string
		edit           func(*fakeNetBox)
	}{
		{"written by Terraform", "", fakeTerraform, fakeTerraform, nil},
		{"written by another user", "binding last changed by owner, not Terraform", "owner", fakeTerraform, nil},
		{"edited by another user after Terraform", "binding last changed by owner, not Terraform", fakeTerraform, fakeTerraform, func(f *fakeNetBox) {
			f.author = "owner"
			f.set("SER-1", func(d *fakeDevice) { d.CustomFields["approved_ek_hash"] = strings.Repeat("cd", 32) })
			f.set("SER-1", func(d *fakeDevice) { d.CustomFields["approved_ek_hash"] = h })
		}},
		{"another field edited by another user after Terraform", "", fakeTerraform, fakeTerraform, func(f *fakeNetBox) {
			f.author = "owner"
			f.set("SER-1", func(d *fakeDevice) { d.CustomFields["talos_class"] = "worker-g2" })
		}},
		{"changelog unreadable", "counts for nothing", fakeTerraform, fakeTerraform, func(f *fakeNetBox) { f.failChanges = true }},
		{"changelog pruned", "pruned", fakeTerraform, fakeTerraform, func(f *fakeNetBox) { f.changes = nil }},
		{"no author set", "no binding author is set", fakeTerraform, "", nil},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newFakeNetBox(t)
			f.add("one", "SER-1", statusPlanned, "", map[string]any{"talos_class": "worker-g5"})
			f.author = c.writer
			f.set("SER-1", func(d *fakeDevice) { d.CustomFields["approved_ek_hash"] = h })
			if c.edit != nil {
				c.edit(f)
			}
			v := &Verifier{NetBox: f.client(), BindingAuthor: c.author, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Now: time.Now}
			m, ok, err := v.lookupMachine(context.Background(), "SER-1")
			if err != nil || !ok {
				t.Fatalf("lookup: %v %v", ok, err)
			}
			err = v.bindingAuthored(context.Background(), m)
			if c.refused == "" {
				if err != nil {
					t.Fatalf("a binding Terraform wrote was refused: %v", err)
				}
				return
			}
			if reasonOf(err) != reasonBindingAuthor || !strings.Contains(err.Error(), c.refused) {
				t.Fatalf("refusal %v, want %q", err, c.refused)
			}
			deadline := time.Now().Add(5 * time.Second)
			for {
				f.mu.Lock()
				n := len(f.journal)
				f.mu.Unlock()
				if n == 1 {
					break
				}
				if time.Now().After(deadline) {
					t.Fatalf("%d journal entries for the refusal", n)
				}
				time.Sleep(20 * time.Millisecond)
			}
		})
	}
}
