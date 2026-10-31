package attest

import (
	"crypto/sha1"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jonpulsifer/infra/apps/fleetd/protocol"
)

// A machine's name is one path element. A claimed serial or hostname never
// becomes a path under the state directory.
func TestStoreRefusesPathsAsNames(t *testing.T) {
	dir := t.TempDir()
	s, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Save(Record{Machine: "riptide", Serial: "MXL1", Status: StatusAttested, UpdatedAt: time.Now()}, nil); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"", ".", "..", "x/../riptide", "../riptide", `..\riptide`, "a/b", "nul\x00"} {
		if err := s.Save(Record{Machine: name, Serial: "EVIL", Status: StatusQuarantined}, nil); err == nil {
			t.Errorf("Save accepted the name %q", name)
		}
		if _, _, err := s.Record(name); err == nil {
			t.Errorf("Record accepted the name %q", name)
		}
		if _, err := s.File(name, fileLDevIDCert); err == nil {
			t.Errorf("File accepted the name %q", name)
		}
	}
	rec, ok, err := s.Record("riptide")
	if err != nil || !ok || rec.Status != StatusAttested || rec.Serial != "MXL1" {
		t.Fatalf("riptide's record after the attempts: %+v %v %v", rec, ok, err)
	}
	entries, _ := os.ReadDir(filepath.Join(dir, "machines"))
	if len(entries) != 1 {
		t.Fatalf("the state directory holds %d entries", len(entries))
	}
}

// The intake name a claim for a serial NetBox lacks waits under is a safe
// slug of the claimed serial, never a path.
func TestIntakeNameNeverIsAPath(t *testing.T) {
	for serial, want := range map[string]string{
		"MXL0172Q6L":           "intake-mxl0172q6l",
		"X/../riptide":         "intake-xx2fx2ex2ex2friptide",
		"../../etc":            "intake-x2ex2ex2fx2ex2ex2fetc",
		"abc def":              "intake-abcx20def",
		"-weird_serial.v2-":    "intake--weirdx5fserialx2ev2-",
		"  spaced  ":           "intake-spaced",
		`back\slash`:           "intake-backx5cslash",
		"\x00nul":              "intake-x0nul",
		strings.Repeat("a", 5): "intake-aaaaa",
	} {
		got := intakeName(protocol.Machine{Serial: serial, Hostname: "hookos"})
		if got != want || strings.ContainsAny(got, `/\`) || strings.Contains(got, "..") {
			t.Errorf("intakeName(%q) = %q, want %q", serial, got, want)
		}
	}
}

// The pending store is capped, the oldest claims give way, and a slug two
// serials share never hands one serial's claim to the other.
func TestPendingStoreIsCappedAndKeyedBySerial(t *testing.T) {
	s, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s.PendingMax = 2
	t0 := time.Date(2026, 10, 29, 1, 0, 0, 0, time.UTC)
	for i, serial := range []string{"P-1", "P-2", "P-3"} {
		if err := s.SavePending(Pending{Serial: serial, EKHashes: map[string]string{"rsa": "a"}, UpdatedAt: t0.Add(time.Duration(i) * time.Minute)}); err != nil {
			t.Fatal(err)
		}
	}
	ps, _ := s.Pendings()
	if len(ps) != 2 || ps[0].Serial != "P-2" || ps[1].Serial != "P-3" {
		t.Fatalf("pending after the cap: %+v", ps)
	}
	// Writing a serial again replaces its own claim and evicts nobody else.
	if err := s.SavePending(Pending{Serial: "p-3", EKHashes: map[string]string{"rsa": "b"}, UpdatedAt: t0.Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	if ps, _ := s.Pendings(); len(ps) != 2 {
		t.Fatalf("a rewrite evicted a claim: %+v", ps)
	}
	if p, ok, _ := s.Pending("P-3"); !ok || p.EKHashes["rsa"] != "b" || p.Serial != "P-3" {
		t.Fatalf("rewritten claim %+v %v", p, ok)
	}
	// "A_B" and "AX5FB" share the slug ax5fb; a claim for one is not the other's.
	if err := s.SavePending(Pending{Serial: "A_B", EKHashes: map[string]string{"rsa": "c"}, UpdatedAt: t0.Add(2 * time.Hour)}); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := s.Pending("AX5FB"); ok {
		t.Fatal("a slug collision handed one serial's claim to another")
	}
	if p, ok, _ := s.Pending("a_b"); !ok || p.Serial != "A_B" {
		t.Fatalf("the claim by its own serial: %+v %v", p, ok)
	}
}

// One serial has one record: a save under a new name retires the old
// directory, and the lookup by serial prefers the newest.
func TestStoreKeepsOneRecordPerSerial(t *testing.T) {
	s, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t0 := time.Date(2026, 10, 29, 1, 0, 0, 0, time.UTC)
	if err := s.Save(Record{Machine: "intake-mxl9", Serial: "MXL9", Status: StatusPending, UpdatedAt: t0}, nil); err != nil {
		t.Fatal(err)
	}
	if err := s.Save(Record{Machine: "shoal", Serial: "mxl9", Status: StatusAttested, UpdatedAt: t0.Add(time.Hour)}, map[string][]byte{fileLDevIDCert: []byte("pem")}); err != nil {
		t.Fatal(err)
	}
	// A save alone retires nothing: only a pass, which proved the serial, does.
	if _, ok, _ := s.Record("intake-mxl9"); !ok {
		t.Fatal("a save retired another record on its own")
	}
	if err := s.RetireOthers("MXL9", "shoal"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := s.Record("intake-mxl9"); ok {
		t.Fatal("the intake record survived the rename")
	}
	if _, ok, _ := s.Record("shoal"); !ok {
		t.Fatal("the kept record was retired")
	}
	rec, ok, _ := s.RecordBySerial("MXL9")
	if !ok || rec.Machine != "shoal" || rec.Status != StatusAttested {
		t.Fatalf("by serial: %+v %v", rec, ok)
	}
	recs, _ := s.Records()
	if len(recs) != 1 {
		t.Fatalf("%d records", len(recs))
	}
	// Two names for one serial that both exist, as after a crash: the newest wins.
	if err := os.MkdirAll(filepath.Join(s.dir, "machines", "aaa-old"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.dir, "machines", "aaa-old", "record.json"), []byte(`{"machine":"aaa-old","serial":"MXL9","status":"attested","updated_at":"2026-10-29T00:00:00Z"}`), 0o640); err != nil {
		t.Fatal(err)
	}
	if rec, _, _ := s.RecordBySerial("MXL9"); rec.Machine != "shoal" {
		t.Fatalf("by serial with an older twin: %+v", rec)
	}
}

// A machine's identity is the SHA-1 of its LDevID, the agent ID SPIRE's
// tpm_devid gives it, and its EK hashes; one with no LDevID has only hashes.
func TestStoreIdentities(t *testing.T) {
	s, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	leaf := newTestCA(t, "surge", nil, 0).cert
	ca := newTestCA(t, "FML DevID test CA", nil, 0).cert
	var chain []byte
	for _, c := range []*x509.Certificate{leaf, ca} {
		chain = append(chain, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: c.Raw})...)
	}
	if err := s.Save(Record{Machine: "surge", Serial: "S1", EKHashes: map[string]string{"rsa": "bb", "ecc": "aa"}}, map[string][]byte{fileLDevIDCert: chain}); err != nil {
		t.Fatal(err)
	}
	if err := s.Save(Record{Machine: "swell", Serial: "S2", EKHashes: map[string]string{"rsa": "cc"}}, nil); err != nil {
		t.Fatal(err)
	}
	ids, err := s.Identities()
	if err != nil {
		t.Fatal(err)
	}
	sum := sha1.Sum(leaf.Raw)
	want := []Identity{
		{Machine: "surge", Fingerprint: hex.EncodeToString(sum[:]), NotAfter: leaf.NotAfter, EKHashes: []string{"aa", "bb"}},
		{Machine: "swell", EKHashes: []string{"cc"}},
	}
	if !reflect.DeepEqual(ids, want) {
		t.Errorf("identities:\n got %+v\nwant %+v", ids, want)
	}
}
