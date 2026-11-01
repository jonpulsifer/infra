package attest

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/go-attestation/attest"

	"github.com/jonpulsifer/infra/apps/fleetd/protocol"
)

func quietVerifier(t *testing.T) (*Verifier, *bytes.Buffer) {
	t.Helper()
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	var audit bytes.Buffer
	return &Verifier{Store: store, Audit: &Audit{W: &audit, Site: "folly"}, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Now: time.Now}, &audit
}

func ek(alg, hash, issuer string) VerifiedEK { return VerifiedEK{Alg: alg, Hash: hash, Issuer: issuer} }

func TestCheckPinnedHoldsAPastPlannedDeviceToTheStoresProof(t *testing.T) {
	proven := map[string]string{"rsa": "r1", "ecc": "e1"}
	active := Machine{Name: "testbox", NetBoxID: 7, Status: "active"}
	withPins := active
	withPins.Pins = map[string]string{"rsa": "r2", "ecc": "e2"}
	approved := withPins
	approved.Approved = map[string]string{"rsa": "r2", "ecc": "e2"}
	planned := withPins
	planned.Status = statusPlanned
	unknown := Machine{Name: "stranger", Serial: "X", Status: "active"}

	for _, c := range []struct {
		name   string
		m      Machine
		proven map[string]string
		eks    []VerifiedEK
		want   string
	}{
		{"the proven EKs", withPins, proven, []VerifiedEK{ek("rsa", "r1", "maker"), ek("ecc", "e1", "maker")}, ""},
		{"the proven EKs beside NetBox pins that differ", active, proven, []VerifiedEK{ek("rsa", "r1", "maker"), ek("ecc", "e1", "")}, ""},
		{"the EKs the pins name", withPins, proven, []VerifiedEK{ek("rsa", "r2", "maker"), ek("ecc", "e2", "maker")}, reasonBindingRemoved},
		{"one proven EK missing", withPins, proven, []VerifiedEK{ek("rsa", "r1", "maker")}, reasonBindingRemoved},
		{"pins and no proof", withPins, nil, []VerifiedEK{ek("rsa", "r2", "maker"), ek("ecc", "e2", "maker")}, reasonBindingRemoved},
		{"no pins and no proof waits", active, nil, []VerifiedEK{ek("rsa", "r1", "maker")}, reasonEKPending},
		{"a serial NetBox lacks waits", unknown, proven, []VerifiedEK{ek("rsa", "r1", "maker")}, reasonEKPending},
		{"a planned device waits", planned, proven, []VerifiedEK{ek("rsa", "r1", "maker")}, reasonEKPending},
		{"an approved binding is not the proof", approved, proven, []VerifiedEK{ek("rsa", "r1", "maker"), ek("ecc", "e1", "maker")}, reasonEKHash},
		{"an approved binding", approved, nil, []VerifiedEK{ek("rsa", "r2", "maker"), ek("ecc", "e2", "maker")}, ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			err := checkPinned(c.m, c.proven, c.eks)
			if (c.want == "") != (err == nil) || (err != nil && reasonOf(err) != c.want) {
				t.Fatalf("got %v, want reason %q", err, c.want)
			}
		})
	}
}

func TestProvenHashesComeFromTheStoresRecord(t *testing.T) {
	for _, c := range []struct {
		name string
		rec  Record
		want int
	}{
		{"an intake pass", Record{Status: StatusAttested, ProvenEKs: map[string]string{"rsa": "a"}, EKHashes: map[string]string{"rsa": "a", "ecc": "b"}}, 1},
		{"a record from before ProvenEKs", Record{Status: StatusAttested, EKProven: true, EKHashes: map[string]string{"rsa": "a"}}, 1},
		{"hashes a renewal did not prove", Record{Status: StatusAttested, EKHashes: map[string]string{"rsa": "a"}}, 0},
		{"a retired record", Record{Status: StatusRetired, ProvenEKs: map[string]string{"rsa": "a"}}, 0},
	} {
		if got := len(c.rec.provenHashes()); got != c.want {
			t.Errorf("%s: %d proven hashes, want %d", c.name, got, c.want)
		}
	}
}

// pinnedMachineFromStore: the Verifier reads the proof from its own store.
func TestVerifierPinnedReadsTheStore(t *testing.T) {
	v, _ := quietVerifier(t)
	m := Machine{Name: "testbox", Serial: "SN-1", NetBoxID: 7, Status: "active", Pins: map[string]string{"rsa": "r2"}}
	eks := []VerifiedEK{ek("rsa", "r1", "maker")}
	if err := v.pinned(m, eks); reasonOf(err) != reasonBindingRemoved {
		t.Fatalf("no record: %v", err)
	}
	rec := Record{Machine: "testbox", Serial: "SN-1", Status: StatusAttested, EKProven: true, ProvenEKs: map[string]string{"rsa": "r1"}, EKHashes: map[string]string{"rsa": "r1"}}
	if err := v.Store.Save(rec, nil); err != nil {
		t.Fatal(err)
	}
	if err := v.pinned(m, eks); err != nil {
		t.Fatalf("the proven EK: %v", err)
	}
	if err := v.pinned(m, []VerifiedEK{ek("rsa", "r2", "maker")}); reasonOf(err) != reasonBindingRemoved {
		t.Fatalf("the EK NetBox pins: %v", err)
	}
}

// riptideLog filters the committed log: keep says which events stay.
func filterEventLog(t *testing.T, raw []byte, keep func(pcr uint32) bool) []byte {
	t.Helper()
	sizes := map[uint16]int{0x0004: 20, 0x000b: 32, 0x000c: 48, 0x000d: 64, 0x0012: 32}
	u32 := func(b []byte) uint32 { return binary.LittleEndian.Uint32(b) }
	// The header is a TCG_PCR_EVENT: PCR, type, a SHA-1 digest, a size, the data.
	end := 4 + 4 + 20 + 4 + int(u32(raw[28:]))
	out := append([]byte(nil), raw[:end]...)
	for off := end; off < len(raw); {
		start, pcr := off, u32(raw[off:])
		n := int(u32(raw[off+8:]))
		off += 12
		for i := 0; i < n; i++ {
			size, ok := sizes[binary.LittleEndian.Uint16(raw[off:])]
			if !ok {
				t.Fatalf("digest algorithm %x", raw[off:off+2])
			}
			off += 2 + size
		}
		off += 4 + int(u32(raw[off:]))
		if keep(pcr) {
			out = append(out, raw[start:off]...)
		}
	}
	return out
}

func replayWith(t *testing.T, v *Verifier, log []byte, pcrs []attest.PCR, p *Policy) error {
	t.Helper()
	_, err := v.replayBoot(pcrs, log, p, p.Evaluate)
	return err
}

func TestAFullLogStillReplaysAndPassesCoverage(t *testing.T) {
	v, _ := quietVerifier(t)
	raw := readFile(t, "testdata/riptide-eventlog.bin")
	p := loadPolicy(t)
	p.RequiredAuthorities = nil
	pcrs := attestPCRs(replayPCRs(t, raw))
	if err := replayWith(t, v, raw, pcrs, p); err != nil {
		t.Fatalf("the full log: %v", err)
	}
	if kept := filterEventLog(t, raw, func(uint32) bool { return true }); !bytes.Equal(kept, raw) {
		t.Fatal("the filter changes a log it keeps whole")
	}
}

// go-attestation replays a PCR that has no events to any value, so a log with
// PCR 4's events stripped passes against PCR 4's real quoted value unless
// the verifier asks for the events.
func TestALogWithoutAPCRsEventsIsRefused(t *testing.T) {
	v, _ := quietVerifier(t)
	raw := readFile(t, "testdata/riptide-eventlog.bin")
	p := loadPolicy(t)
	p.RequiredAuthorities = nil
	real := replayPCRs(t, raw)
	stripped := filterEventLog(t, raw, func(pcr uint32) bool { return pcr != 4 })
	pcrs := attestPCRs(real)

	el, err := attest.ParseEventLog(stripped)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := el.Verify(pcrs); err != nil {
		t.Fatalf("go-attestation no longer replays a PCR with no events to any value: %v", err)
	}
	err = replayWith(t, v, stripped, pcrs, p)
	if reasonOf(err) != reasonEventLog || !strings.Contains(err.Error(), "PCR 4") {
		t.Fatalf("a log without PCR 4's events: %v", err)
	}

	// A PCR that holds its initial value needs no events.
	zero := replayPCRs(t, raw)
	zero[4] = make([]byte, 32)
	err = replayWith(t, v, stripped, attestPCRs(zero), p)
	if reasonOf(err) == reasonEventLog {
		t.Fatalf("an untouched PCR 4: %v", err)
	}
}

func TestPinnedBootApplicationsNeedOneAfterTheSeparator(t *testing.T) {
	v, _ := quietVerifier(t)
	raw := readFile(t, "testdata/riptide-eventlog.bin")
	p := loadPolicy(t)
	p.RequiredAuthorities = nil
	p.BootApplications = []string{"a7aaadd78bbcd9bf1af39ca49fceebba1c386a2e74f652f303fb3c412dcfab4d", "643b708da5cc28126900c393e49bd58b45d4dcc342a5c43772752d70be057922"}
	zero := replayPCRs(t, raw)
	zero[4] = make([]byte, 32)
	stripped := filterEventLog(t, raw, func(pcr uint32) bool { return pcr != 4 })
	err := replayWith(t, v, stripped, attestPCRs(zero), p)
	if reasonOf(err) != reasonPolicy || !strings.Contains(err.Error(), "no boot application") {
		t.Fatalf("pinned boot applications and none recorded: %v", err)
	}
	if err := replayWith(t, v, raw, attestPCRs(replayPCRs(t, raw)), p); err != nil {
		t.Fatalf("the real boot: %v", err)
	}
}

func TestStartBoundsEveryClaimBeforeItLogsAnything(t *testing.T) {
	long := func(n int) string { return strings.Repeat("a", n) }
	for _, c := range []struct {
		name   string
		change func(*protocol.Machine)
		reason string
	}{
		{"serial", func(m *protocol.Machine) { m.Serial = long(65) }, reasonSerial},
		{"MAC", func(m *protocol.Machine) { m.MAC = long(18) }, reasonField},
		{"not a MAC", func(m *protocol.Machine) { m.MAC = "zz:zz" }, reasonMACInvalid},
		{"no MAC", func(m *protocol.Machine) { m.MAC = "" }, reasonMACInvalid},
		{"UUID", func(m *protocol.Machine) { m.UUID = long(37) }, reasonField},
		{"hostname", func(m *protocol.Machine) { m.Hostname = long(254) }, reasonField},
		{"manufacturer", func(m *protocol.Machine) { m.Manufacturer = long(129) }, reasonField},
		{"model", func(m *protocol.Machine) { m.Model = long(129) }, reasonField},
		{"SKU", func(m *protocol.Machine) { m.SKU = long(129) }, reasonField},
		{"BIOS version", func(m *protocol.Machine) { m.BIOS = long(129) }, reasonField},
	} {
		t.Run(c.name, func(t *testing.T) {
			v, audit := quietVerifier(t)
			claim := protocol.Machine{Serial: "SN-1", MAC: "02:00:00:00:00:01"}
			c.change(&claim)
			_, err := v.Start(context.Background(), protocol.StartRequest{Machine: claim}, "10.0.0.1")
			if reasonOf(err) != c.reason {
				t.Fatalf("got %v, want %s", err, c.reason)
			}
			if _, statErr := os.Stat(filepath.Join(v.Store.dir, "verdicts.jsonl")); statErr == nil {
				t.Fatal("junk input wrote a journal line")
			}
			if audit.Len() != 0 {
				t.Fatalf("junk input wrote an audit line: %s", audit)
			}
			if n := v.Verdicts()[[2]string{protocol.VerdictRefused, c.reason}]; n != 1 {
				t.Fatalf("the refusal was counted %d times", n)
			}

			// And the answer is a bounded 400.
			srv := &Server{V: v, Log: v.Log}
			body, _ := json.Marshal(protocol.StartRequest{Machine: claim})
			rr := httptest.NewRecorder()
			srv.Public().ServeHTTP(rr, httptest.NewRequest(http.MethodPost, protocol.PathStart, bytes.NewReader(body)))
			if rr.Code != http.StatusBadRequest || rr.Body.Len() > 512 || strings.Contains(rr.Body.String(), long(17)) {
				t.Fatalf("answer %d %s", rr.Code, rr.Body)
			}
		})
	}
}

func TestRejectNeverEchoesAClaimBeyondALimit(t *testing.T) {
	v, audit := quietVerifier(t)
	long := strings.Repeat("z", 400)
	err := v.reject(nil, protocol.Machine{Serial: long, MAC: long}, fail(reasonStatus, "%s", long))
	if reasonOf(err) != reasonStatus {
		t.Fatal(err)
	}
	journal, _ := os.ReadFile(filepath.Join(v.Store.dir, "verdicts.jsonl"))
	for name, text := range map[string]string{"journal": string(journal), "audit": audit.String()} {
		if strings.Contains(text, strings.Repeat("z", maxEcho+1)) || !strings.Contains(text, "...") {
			t.Errorf("%s repeats the claim whole or leaves no marker: %s", name, text)
		}
	}
	if got := clip(strings.Repeat("é", 100)); len(got) > maxEcho+3 || !strings.HasSuffix(got, "...") {
		t.Errorf("clip of multi-byte text: %q", got)
	}
}

func TestJournalRotatesOnceAtItsCap(t *testing.T) {
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	store.JournalMax = 200
	line := map[string]string{"k": strings.Repeat("v", 60)}
	for i := 0; i < 10; i++ {
		if err := store.Journal(line); err != nil {
			t.Fatal(err)
		}
	}
	size := func(name string) int64 {
		fi, err := os.Stat(filepath.Join(store.dir, name))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		return fi.Size()
	}
	if size("verdicts.jsonl") > 200 || size("verdicts.jsonl.1") > 200 {
		t.Fatalf("journal %d, rotated %d bytes", size("verdicts.jsonl"), size("verdicts.jsonl.1"))
	}
	if _, err := os.Stat(filepath.Join(store.dir, "verdicts.jsonl.2")); err == nil {
		t.Fatal("more than one rotation is kept")
	}
	if fresh, _ := OpenStore(t.TempDir()); fresh.JournalMax != 0 {
		t.Fatal("the cap has a default of 64 MiB when zero")
	}
}

func TestChangedCoalescesTheMetricsRewrite(t *testing.T) {
	v, _ := quietVerifier(t)
	var runs atomic.Int32
	var scheduled []func()
	var delays []time.Duration
	v.OnChange = func() { runs.Add(1) }
	v.AfterFunc = func(d time.Duration, f func()) { delays, scheduled = append(delays, d), append(scheduled, f) }
	for i := 0; i < 50; i++ {
		v.changed()
	}
	if len(scheduled) != 1 || runs.Load() != 0 || delays[0] != 5*time.Second {
		t.Fatalf("%d runs scheduled for %v, %d done", len(scheduled), delays, runs.Load())
	}
	scheduled[0]()
	if runs.Load() != 1 {
		t.Fatalf("%d rewrites", runs.Load())
	}
	v.changed()
	if len(scheduled) != 2 {
		t.Fatal("a change after the run is lost")
	}
	scheduled[1]()
	if runs.Load() != 2 {
		t.Fatalf("%d rewrites", runs.Load())
	}
}

func TestOpenDoesNotLetAnUnprovenRequestDisplaceASession(t *testing.T) {
	now := time.Now()
	v := &Verifier{Now: func() time.Time { return now }}
	m := Machine{Name: "testbox"}
	expires := now.Add(time.Hour)
	legit := v.open(&session{machine: m, expires: expires, remote: "10.0.0.5"})
	now = now.Add(time.Second)
	again := v.open(&session{machine: m, expires: expires, remote: "10.0.0.5"})
	if _, ok := v.sessions[legit]; ok {
		t.Fatal("the same peer keeps two sessions for a machine")
	}
	var ids []string
	for i := 0; i < 10; i++ {
		now = now.Add(time.Second)
		ids = append(ids, v.open(&session{machine: m, expires: expires, remote: "203.0.113." + string(rune('0'+i))}))
	}
	if _, ok := v.sessions[again]; ok && len(v.sessions) > sessionsPerMachine {
		t.Fatal("the sessions of one machine are unbounded")
	}
	if len(v.sessions) != sessionsPerMachine {
		t.Fatalf("%d sessions, want the newest %d", len(v.sessions), sessionsPerMachine)
	}
	for _, id := range ids[len(ids)-sessionsPerMachine:] {
		if _, ok := v.sessions[id]; !ok {
			t.Fatal("a newest session was dropped")
		}
	}
	other := v.open(&session{machine: Machine{Name: "swell"}, expires: expires, remote: "10.0.0.9"})
	if _, ok := v.sessions[other]; !ok || len(v.sessions) != sessionsPerMachine+1 {
		t.Fatal("another machine's session counts against this one's bound")
	}
}

func TestPublicServesOnlyTheDeviceFlow(t *testing.T) {
	v, _ := quietVerifier(t)
	srv := &Server{V: v, Log: v.Log}
	for _, c := range []struct{ method, path string }{
		{http.MethodGet, "/devid/SN-1"}, {http.MethodGet, "/devid/SN-1/ldevid.priv"}, {http.MethodGet, "/verdict/SN-1"},
		{http.MethodPost, "/v1/renew"}, {http.MethodPost, "/v1/renew/s/evidence"}, {http.MethodGet, "/metrics"},
	} {
		rr := httptest.NewRecorder()
		srv.Public().ServeHTTP(rr, httptest.NewRequest(c.method, c.path, nil))
		if rr.Code != http.StatusNotFound && rr.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s %s on the boot listener: %d", c.method, c.path, rr.Code)
		}
	}
	rr := httptest.NewRecorder()
	srv.DevIDHandler().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if rr.Code != http.StatusOK {
		t.Errorf("the DevID listener lost /healthz: %d", rr.Code)
	}
}
