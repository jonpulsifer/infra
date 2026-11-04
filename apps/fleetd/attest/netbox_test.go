package attest

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jonpulsifer/infra/apps/fleetd/protocol"
)

func TestNetBoxLookupReadsTheDevice(t *testing.T) {
	f := newFakeNetBox(t)
	f.add("riptide", "MXL0172Q6L", "active", "38:22:E2:2D:96:44", map[string]any{
		"class": "worker-g5", "ek_hash": strings.Repeat("A", 64), "ek_hash_ecc": strings.Repeat("b", 64),
		"approved_ek_hash": strings.Repeat("c", 64), "approved_ek_hash_ecc": nil, "attest_verdict": "attested", "last_attested": "2026-10-29T01:02:03Z", "attest_consumed_at": "2026-10-29T01:10:00Z",
	})
	nb := f.client()
	m, ok, err := nb.Lookup(context.Background(), "mxl0172q6l")
	if err != nil || !ok {
		t.Fatalf("lookup: %v %v", ok, err)
	}
	if m.Name != "riptide" || m.Class != "worker-g5" || m.Status != "active" || m.MAC != "38:22:e2:2d:96:44" || m.Pins["rsa"] != strings.Repeat("a", 64) || m.Pins["ecc"] != strings.Repeat("b", 64) || m.NetBoxID == 0 ||
		len(m.Approved) != 1 || m.Approved["rsa"] != strings.Repeat("c", 64) {
		t.Fatalf("machine %+v", m)
	}
	if _, ok, err := nb.Lookup(context.Background(), "NOPE"); ok || err != nil {
		t.Fatalf("unknown serial: %v %v", ok, err)
	}
	st, ok, err := nb.Verdict(context.Background(), "MXL0172Q6L")
	if err != nil || !ok || st.Status != protocol.StatusAttested || st.Node != "riptide" || st.Class != "worker-g5" || st.Site != "folly" ||
		!st.AttestedAt.Equal(time.Date(2026, 10, 29, 1, 2, 3, 0, time.UTC)) || !st.ConsumedAt.Equal(time.Date(2026, 10, 29, 1, 10, 0, 0, time.UTC)) {
		t.Fatalf("verdict %+v %v %v", st, ok, err)
	}
	f.add("swell", "SW-1", "planned", "", map[string]any{"attest_verdict": "pending-approval"})
	if _, ok, _ := nb.Verdict(context.Background(), "SW-1"); ok {
		t.Fatal("a pending device has a verdict")
	}
	f.add("surge", "SU-1", "failed", "", map[string]any{"attest_verdict": "quarantined: policy"})
	if st, ok, _ := nb.Verdict(context.Background(), "SU-1"); !ok || st.Status != protocol.StatusQuarantined {
		t.Fatalf("quarantined verdict %+v %v", st, ok)
	}
	// A retired device has no verdict to serve, whatever its fields say.
	f.add("retired", "RT-1", "offline", "", map[string]any{"attest_verdict": StatusAttested, "last_attested": "2026-10-29T01:02:03Z"})
	if _, ok, _ := nb.Verdict(context.Background(), "RT-1"); ok {
		t.Fatal("a retired device has a verdict")
	}
	// A 200 with no page is not an answer.
	empty := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, http.StatusOK, map[string]any{}) }))
	defer empty.Close()
	hollow := NewNetBox(empty.URL, "nbt_x", empty.Client(), nil)
	if _, ok, err := hollow.Lookup(context.Background(), "ANY"); err == nil || ok {
		t.Fatalf("an empty page read as no such device: %v %v", ok, err)
	}
}

func TestNetBoxRecordWritesTheVerdict(t *testing.T) {
	f := newFakeNetBox(t)
	nb := f.client()
	f.add("swell", "SW-1", "planned", "aa:bb:cc:dd:ee:01", nil)
	now := time.Date(2026, 10, 29, 2, 0, 0, 0, time.UTC)
	pass := Record{Machine: "swell", Serial: "SW-1", Status: StatusAttested, Class: "worker-g5", SKU: "SKU1", BIOS: "B1", EKProven: true,
		EKHashes: map[string]string{"rsa": strings.Repeat("1", 64), "ecc": strings.Repeat("2", 64)}, EKIssuers: []string{"Infineon OPTIGA(TM) TPM 2.0 RSA CA 042"},
		LDevIDSerial: "0a", LAKSerial: "0b", AttestedAt: now, LDevIDNotAfter: now.Add(90 * 24 * time.Hour)}
	if err := nb.Record(context.Background(), pass); err != nil {
		t.Fatal(err)
	}
	d := f.bySerial("SW-1")
	cf := d.CustomFields
	if d.Status != "planned" || cf["attest_verdict"] != "attested" || cf["ek_hash"] != strings.Repeat("1", 64) || cf["ek_hash_ecc"] != strings.Repeat("2", 64) ||
		cf["ldevid_serial"] != "0a" || cf["lak_serial"] != "0b" || cf["last_attested"] != "2026-10-29T02:00:00Z" || cf["ldevid_not_after"] != "2027-01-27" || cf["sku"] != "SKU1" || cf["bios_version"] != "B1" {
		t.Fatalf("after a pass: %s %+v", d.Status, cf)
	}
	// A pass whose session did not prove the EKs, a renewal or an adopted
	// record, writes no pins and no SMBIOS facts it did not see.
	renewal := pass
	renewal.EKProven, renewal.Renewed, renewal.SKU, renewal.BIOS = false, true, "", ""
	renewal.EKHashes = map[string]string{"rsa": strings.Repeat("9", 64)}
	renewal.LDevIDSerial = "0c"
	if err := nb.Record(context.Background(), renewal); err != nil {
		t.Fatal(err)
	}
	if d := f.bySerial("SW-1"); d.CustomFields["ek_hash"] != strings.Repeat("1", 64) || d.CustomFields["ldevid_serial"] != "0c" || d.CustomFields["sku"] != "SKU1" {
		t.Fatalf("after a renewal: %+v", d.CustomFields)
	}
	quarantine := Record{Machine: "swell", Serial: "SW-1", Status: StatusQuarantined, Reason: reasonEKHash, Detail: []string{"rsa EK x is not swell's pinned y **[bold](http://x)**"},
		EKHashes: map[string]string{"rsa": strings.Repeat("f", 64)}, EKProven: true, SKU: "SKU-CLAIMED"}
	if err := nb.Record(context.Background(), quarantine); err != nil {
		t.Fatal(err)
	}
	d = f.bySerial("SW-1")
	if d.Status != "planned" || d.CustomFields["attest_verdict"] != "quarantined: ek-hash-mismatch" {
		t.Fatalf("after a quarantine: %s %+v", d.Status, d.CustomFields)
	}
	// A refusal never rewrites the pins nor the hardware facts.
	if d.CustomFields["ek_hash"] != strings.Repeat("1", 64) || d.CustomFields["sku"] != "SKU1" {
		t.Fatalf("a quarantine rewrote ek_hash or sku: %+v", d.CustomFields)
	}
	// A first intake's wait is noted, but never over a pass or a quarantine on file.
	if err := nb.MarkPending(context.Background(), "SW-1", "no EK hash on record"); err != nil {
		t.Fatal(err)
	}
	if d := f.bySerial("SW-1"); d.CustomFields["attest_verdict"] != "quarantined: ek-hash-mismatch" || d.Status != "planned" {
		t.Fatalf("a claim wrote over the quarantine: %s %+v", d.Status, d.CustomFields)
	}
	f.add("shale", "SL-1", "planned", "", nil)
	if err := nb.MarkPending(context.Background(), "SL-1", "no EK hash on record"); err != nil {
		t.Fatal(err)
	}
	if d := f.bySerial("SL-1"); d.CustomFields["attest_verdict"] != StatusPending || d.Status != "planned" {
		t.Fatalf("after pending: %s %+v", d.Status, d.CustomFields)
	}
	f.add("shoal", "SH-1", "planned", "", map[string]any{"attest_verdict": StatusAttested})
	if err := nb.MarkPending(context.Background(), "SH-1", "a claim"); err != nil {
		t.Fatal(err)
	}
	if d := f.bySerial("SH-1"); d.CustomFields["attest_verdict"] != StatusAttested || d.Patches != 0 {
		t.Fatalf("a claim wrote over a pass: %+v", d.CustomFields)
	}
	// Nor over a quarantine: that stands until the owner clears it.
	f.add("surge", "SU-9", "failed", "", map[string]any{"attest_verdict": "quarantined: policy"})
	if err := nb.MarkPending(context.Background(), "SU-9", "a claim"); err != nil {
		t.Fatal(err)
	}
	if d := f.bySerial("SU-9"); d.CustomFields["attest_verdict"] != "quarantined: policy" || d.Patches != 0 {
		t.Fatalf("a claim wrote over a quarantine: %+v", d.CustomFields)
	}
	if err := nb.Record(context.Background(), Record{Serial: "NOPE", Status: StatusAttested}); err == nil {
		t.Fatal("a record for an unknown serial was written")
	}
	if err := nb.Record(context.Background(), Record{Serial: "SW-1", Status: StatusPending}); err == nil {
		t.Fatal("a pending record was written as a verdict")
	}
	// The journal follows the write on its own, with the claimed text flattened.
	deadline := time.Now().Add(5 * time.Second)
	for {
		f.Mu.Lock()
		entries := f.journalLines()
		n := len(entries)
		f.Mu.Unlock()
		if n == 6 {
			for _, e := range entries {
				if strings.Contains(e, "**") || strings.Contains(e, "[bold]") || strings.Contains(e, "(http") {
					t.Fatalf("journal entry carries Markdown: %q", e)
				}
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("journal %q", entries)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestAuditLines(t *testing.T) {
	var b strings.Builder
	a := &Audit{W: &b, Site: "folly", Now: func() time.Time { return time.Date(2026, 10, 29, 3, 0, 0, 0, time.UTC) }}
	a.Emit(AuditEntry{Event: auditVerdict, Node: "riptide", Serial: "MXL0172Q6L", Class: "worker-g5", Status: "pass"})
	want := `{"event":"attest.verdict","site":"folly","node":"riptide","serial":"MXL0172Q6L","class":"worker-g5","status":"pass","ts":"2026-10-29T03:00:00Z"}` + "\n"
	if b.String() != want {
		t.Fatalf("audit line %q", b.String())
	}
	var quiet *Audit
	quiet.Emit(AuditEntry{Event: auditIssue})
}

func TestIntakeName(t *testing.T) {
	for claim, want := range map[protocol.Machine]string{
		{Serial: "ABC", Hostname: "swell"}:       "swell",
		{Serial: "ABC", Hostname: "hookos"}:      "intake-abc",
		{Serial: "ABC", Hostname: "Not A Host!"}: "intake-abc",
		{Serial: "ABC"}:                          "intake-abc",
		{Serial: "ABC", Hostname: "node-01.lan"}: "intake-abc",
		{Serial: " abc ", Hostname: "localhost"}: "intake-abc",
	} {
		if got := intakeName(claim); got != want {
			t.Errorf("intakeName(%+v) = %q, want %q", claim, got, want)
		}
	}
}

// A pass replaces a pin on file only with the approved binding it matched;
// otherwise only an empty pin is written, so a second TPM claiming a stub's
// serial on another anchor cannot re-key it.
func TestNetBoxRecordKeepsAPinOnFile(t *testing.T) {
	f := newFakeNetBox(t)
	nb := f.client()
	f.add("swell", "SW-1", "planned", "", map[string]any{"ek_hash": strings.Repeat("a", 64)})
	pass := Record{Machine: "swell", Serial: "SW-1", Status: StatusAttested, EKProven: true, AttestedAt: time.Now(),
		EKHashes: map[string]string{"rsa": strings.Repeat("1", 64), "ecc": strings.Repeat("2", 64)}}
	if err := nb.Record(context.Background(), pass); err != nil {
		t.Fatal(err)
	}
	if cf := f.bySerial("SW-1").CustomFields; cf["ek_hash"] != strings.Repeat("a", 64) || cf["ek_hash_ecc"] != strings.Repeat("2", 64) {
		t.Fatalf("pins after the pass: %+v", cf)
	}
	pass.approved = map[string]string{"rsa": strings.Repeat("1", 64)}
	if err := nb.Record(context.Background(), pass); err != nil {
		t.Fatal(err)
	}
	if cf := f.bySerial("SW-1").CustomFields; cf["ek_hash"] != strings.Repeat("1", 64) || cf["approved_ek_hash"] != nil {
		t.Fatalf("pins after a pass that matched its approved binding: %+v", cf)
	}
}
