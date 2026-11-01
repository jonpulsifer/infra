package attest

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jonpulsifer/infra/apps/fleetd/protocol"
)

func journalLines(t *testing.T, v *Verifier) int {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(v.Store.dir, "verdicts.jsonl"))
	if err != nil {
		return 0
	}
	return strings.Count(string(b), "\n")
}

func TestPendRateLimitsItsWritesAndSkipsAnUnchangedClaim(t *testing.T) {
	v, _ := quietVerifier(t)
	f := newFakeNetBox(t)
	f.add("testbox", "SN-1", "active", "02:00:00:00:00:01", nil)
	v.NetBox = f.client()
	now := time.Now()
	v.Now = func() time.Time { return now }
	m, ok, err := v.NetBox.Lookup(context.Background(), "SN-1")
	if err != nil || !ok {
		t.Fatal(err)
	}
	claim := protocol.Machine{Serial: "SN-1", MAC: "02:00:00:00:00:01"}
	eks := []VerifiedEK{ek("rsa", "r1", "")}
	pend := func() {
		t.Helper()
		if err := v.pend(context.Background(), m, claim, eks, fail(reasonEKPending, "waits")); reasonOf(err) != reasonEKPending {
			t.Fatal(err)
		}
	}

	pend()
	first, _, _ := v.Store.Pending("SN-1")
	if journalLines(t, v) != 1 || f.bySerial("SN-1").Patches != 1 {
		t.Fatalf("first claim: %d journal lines, %d patches", journalLines(t, v), f.bySerial("SN-1").Patches)
	}
	now = now.Add(time.Minute)
	pend()
	if again, _, _ := v.Store.Pending("SN-1"); !again.UpdatedAt.Equal(first.UpdatedAt) {
		t.Fatal("an unchanged claim was written again")
	}
	if journalLines(t, v) != 1 || f.bySerial("SN-1").Patches != 1 {
		t.Fatalf("repeat claim: %d journal lines, %d patches", journalLines(t, v), f.bySerial("SN-1").Patches)
	}
	eks = []VerifiedEK{ek("rsa", "r2", "")}
	pend()
	if changed, _, _ := v.Store.Pending("SN-1"); changed.EKHashes["rsa"] != "r2" {
		t.Fatal("a changed claim was not stored")
	}
	if journalLines(t, v) != 1 || f.bySerial("SN-1").Patches != 1 {
		t.Fatalf("changed claim inside the window: %d journal lines, %d patches", journalLines(t, v), f.bySerial("SN-1").Patches)
	}
	now = now.Add(claimEvery)
	pend()
	if journalLines(t, v) != 2 || f.bySerial("SN-1").Patches != 2 {
		t.Fatalf("after the window: %d journal lines, %d patches", journalLines(t, v), f.bySerial("SN-1").Patches)
	}
}

func TestJunkSerialsCannotEvictAKnownDevicesClaim(t *testing.T) {
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	store.PendingMax, store.UnknownMax = 3, 2
	now := time.Now()
	claim := func(serial string, unknown bool) Pending {
		now = now.Add(time.Second)
		return Pending{Serial: serial, EKHashes: map[string]string{"rsa": "r"}, Unknown: unknown, UpdatedAt: now}
	}
	if err := store.SavePending(claim("KNOWN-1", false)); err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{"JUNK-1", "JUNK-2", "JUNK-3", "JUNK-4", "JUNK-5"} {
		if err := store.SavePending(claim(s, true)); err != nil {
			t.Fatal(err)
		}
	}
	all, _ := store.Pendings()
	var junk int
	for _, p := range all {
		if p.Unknown {
			junk++
		}
	}
	if _, ok, _ := store.Pending("KNOWN-1"); !ok || junk != 2 {
		t.Fatalf("known claim kept %v, %d junk claims", ok, junk)
	}
	if _, ok, _ := store.Pending("JUNK-5"); !ok {
		t.Fatal("the newest junk claim gave way to an older one")
	}
}
