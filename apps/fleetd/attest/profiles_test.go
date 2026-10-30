package attest

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/hex"
	"math/big"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf16"

	"github.com/google/go-attestation/attest"

	"github.com/jonpulsifer/infra/apps/fleetd/classes"
)

var testClasses = classes.Table{
	"controlplane": {OS: "talos", Template: "provision", PolicyProfile: "talos", SecureBoot: true, PayloadKind: classes.PayloadTalosConfig, Reattest: true},
	"worker-g5":    {OS: "talos", Template: "provision", PolicyProfile: "talos", SecureBoot: true, PayloadKind: classes.PayloadTalosConfig, Reattest: true},
	"worker-g2":    {OS: "talos", Template: "provision", PolicyProfile: "talos", SecureBoot: true, PayloadKind: classes.PayloadTalosConfig},
	"ubuntu":       {OS: "ubuntu", Template: "provision-ubuntu", PolicyProfile: "ubuntu", SecureBoot: true, PayloadKind: classes.PayloadCloudInit},
}

const (
	microsoft2011 = "48e99b991f57fc52f76149599bff0a58c47154229b9f8d603ac40d3500248507"
	canonicalCA   = "ed1fe72cb9ca31c9af5b757afcd733323d675825032e6ced7fe1ae9eb767998c"
)

var (
	dbGUID       = []byte{0xcb, 0xb2, 0x19, 0xd7, 0x3a, 0x3d, 0x96, 0x45, 0xa3, 0xbc, 0xda, 0xd0, 0x0e, 0x67, 0x65, 0x6f}
	shimLockGUID = []byte{0x50, 0xab, 0x5d, 0x60, 0x46, 0xe0, 0x00, 0x43, 0xab, 0xb6, 0x3d, 0xd8, 0x10, 0xdd, 0x8b, 0x23}
)

func variableData(guid []byte, name string, data []byte) []byte {
	u := utf16.Encode([]rune(name))
	b := append([]byte(nil), guid...)
	b = binary.LittleEndian.AppendUint64(b, uint64(len(u)))
	b = binary.LittleEndian.AppendUint64(b, uint64(len(data)))
	for _, c := range u {
		b = binary.LittleEndian.AppendUint16(b, c)
	}
	return append(b, data...)
}

func authorityEvent(guid []byte, name string, data []byte) attest.Event {
	sum := sha256.Sum256(data)
	return attest.Event{Index: 7, Type: eventVariableAuthority, Data: data, Digest: sum[:]}
}

func certAuthority(guid []byte, name string, der []byte) attest.Event {
	sig := append(make([]byte, 16), der...)
	data := variableData(guid, name, sig)
	return authorityEvent(guid, name, data)
}

// ubuntuEvents is riptide's Secure Boot log with its post-separator
// authorities swapped for an Ubuntu boot's: firmware verifies shim with the
// Microsoft CA in db, shim measures its SBAT level and verifies GRUB and the
// kernel with the vendor CA from MokListRT.
func ubuntuEvents(t *testing.T, shimCA, vendorCA []byte) []attest.Event {
	t.Helper()
	var out []attest.Event
	separated := false
	for _, e := range riptideEvents(t) {
		if e.Index == 7 && e.Type == eventSeparator {
			separated = true
		}
		if separated && e.Index == 7 && e.Type == eventVariableAuthority {
			continue
		}
		out = append(out, e)
	}
	sbat := variableData(shimLockGUID, "SbatLevel", []byte("sbat,1,2024010900\nshim,4\ngrub,4\n"))
	return append(out,
		certAuthority(dbGUID, "db", shimCA),
		authorityEvent(shimLockGUID, "SbatLevel", sbat),
		certAuthority(shimLockGUID, "MokListRT", vendorCA),
	)
}

func microsoftDER(t *testing.T) []byte {
	t.Helper()
	sb, err := attest.ParseSecurebootState(riptideEvents(t))
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range sb.PermittedKeys {
		if fingerprint(c) == microsoft2011 {
			return c.Raw
		}
	}
	t.Fatal("riptide's db lacks Microsoft's UEFI CA 2011")
	return nil
}

func profile(t *testing.T, name string) *Policy {
	t.Helper()
	p, err := LoadPolicy(filepath.Join("policy", name+".yaml"))
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestUbuntuProfileAcceptsAStockShimBoot(t *testing.T) {
	canonical := readFile(t, "testdata/canonical-master-ca.der")
	events := ubuntuEvents(t, microsoftDER(t), canonical)
	p := profile(t, "ubuntu")
	if got := p.EvaluateRenewal(events); len(got) != 0 {
		t.Fatalf("violations %q, want none", got)
	}
	if got := p.Evaluate(events); len(got) != 1 || !strings.Contains(got[0], "The boot path lacks FML HookOS Secure Boot") {
		t.Fatalf("violations %q, want only the missing HookOS authority", got)
	}
	if got := profile(t, "talos").EvaluateRenewal(events); len(got) == 0 {
		t.Fatal("the talos profile accepted a Microsoft-signed shim")
	}
}

func TestUbuntuProfileRefusesAnUnlistedCA(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Another Vendor CA"}, NotBefore: time.Now(), NotAfter: time.Now().Add(time.Hour)}
	other, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, key.Public(), key)
	if err != nil {
		t.Fatal(err)
	}
	canonical := readFile(t, "testdata/canonical-master-ca.der")
	p := profile(t, "ubuntu")
	for name, events := range map[string][]attest.Event{
		"a shim signed by an unlisted CA":     ubuntuEvents(t, other, canonical),
		"a kernel verified by an unlisted CA": ubuntuEvents(t, microsoftDER(t), other),
	} {
		got := p.EvaluateRenewal(events)
		if len(got) != 1 || !strings.Contains(got[0], "A boot authority holds") {
			t.Errorf("%s: violations %q", name, got)
		}
	}
}

func TestBootFactsReadDBXAndSBAT(t *testing.T) {
	canonical := readFile(t, "testdata/canonical-master-ca.der")
	f := bootFactsOf(ubuntuEvents(t, microsoftDER(t), canonical))
	sbat := sha256.Sum256([]byte("sbat,1,2024010900\nshim,4\ngrub,4\n"))
	if f.SBAT != hex.EncodeToString(sbat[:]) {
		t.Errorf("SBAT %s", f.SBAT)
	}
	if len(f.DBX) != 64 {
		t.Errorf("dbx %q", f.DBX)
	}
	if got := bootFactsOf(riptideEvents(t)); got.DBX != f.DBX || got.SBAT != "" {
		t.Errorf("a Talos boot: %+v", got)
	}
}

func TestPolicyForFollowsTheClass(t *testing.T) {
	v := &Verifier{Policies: map[string]*Policy{"talos": profile(t, "talos"), "ubuntu": profile(t, "ubuntu")}, Classes: testClasses}
	for class, want := range map[string]string{"": "talos", "worker-g5": "talos", "ubuntu": "ubuntu"} {
		p, err := v.policyFor(class, false)
		if err != nil || p != v.Policies[want] {
			t.Errorf("class %q: %v", class, err)
		}
	}
	for _, class := range []string{"worker-g9"} {
		if _, err := v.policyFor(class, false); reasonOf(err) != reasonInternal {
			t.Errorf("class %q: %v", class, err)
		}
	}
	if _, err := v.policyFor("ubuntu", true); reasonOf(err) != reasonInternal {
		t.Errorf("a class that does not reattest renewed: %v", err)
	}
}

func TestCommittedClassesMatchTheProfiles(t *testing.T) {
	file := inRepo(t, "clusters/folly/fleet/classes.json")
	table, err := classes.Load(file)
	if err != nil {
		t.Fatal(err)
	}
	profiles, err := LoadPolicies("policy")
	if err != nil {
		t.Fatal(err)
	}
	if err := CheckClasses(table, profiles); err != nil {
		t.Fatal(err)
	}
	for _, class := range []string{"controlplane", "worker-g5", "worker-g2"} {
		if table[class].PolicyProfile != "talos" || table[class].Template != "provision" {
			t.Errorf("%s changed: %+v", class, table[class])
		}
	}
	profiles["talos"].SecureBoot = false
	if err := CheckClasses(table, profiles); err == nil {
		t.Fatal("a profile that disagrees about Secure Boot passed")
	}
}

func TestNetBoxRecordWritesDBXAndSBAT(t *testing.T) {
	f := newFakeNetBox(t)
	nb := f.client()
	f.add("swell", "SW-1", "active", "aa:bb:cc:dd:ee:01", map[string]any{"dbx_hash": nil, "sbat_level": nil})
	f.add("plain", "SW-2", "active", "aa:bb:cc:dd:ee:02", nil)
	now := time.Date(2026, 10, 29, 2, 0, 0, 0, time.UTC)
	pass := func(serial, dbx, sbat string) Record {
		return Record{Machine: "swell", Serial: serial, Status: StatusAttested, Class: "ubuntu", AttestedAt: now, check: true, Boot: bootFacts{DBX: dbx, SBAT: sbat}}
	}
	one, two, three := strings.Repeat("1", 64), strings.Repeat("2", 64), strings.Repeat("3", 64)
	if err := nb.Record(context.Background(), pass("SW-1", one, two)); err != nil {
		t.Fatal(err)
	}
	if cf := f.bySerial("SW-1").CustomFields; cf["dbx_hash"] != one || cf["sbat_level"] != two {
		t.Fatalf("after the first pass: %+v", cf)
	}
	// A pass that measured no SBAT level leaves the one on file.
	if err := nb.Record(context.Background(), pass("SW-1", one, "")); err != nil {
		t.Fatal(err)
	}
	if cf := f.bySerial("SW-1").CustomFields; cf["sbat_level"] != two {
		t.Fatalf("an unmeasured SBAT level cleared the field: %+v", cf)
	}
	// A change replaces the value, journals a warning and quarantines nothing.
	if err := nb.Record(context.Background(), pass("SW-1", three, two)); err != nil {
		t.Fatal(err)
	}
	d := f.bySerial("SW-1")
	if d.CustomFields["dbx_hash"] != three || d.CustomFields["attest_verdict"] != StatusAttested || d.Status != "active" {
		t.Fatalf("after a dbx change: %s %+v", d.Status, d.CustomFields)
	}
	deadline := time.Now().Add(5 * time.Second)
	for !journalHas(f, "the dbx hash is "+three+", was "+one) {
		if time.Now().After(deadline) {
			t.Fatalf("no warning in the journal: %q", f.journal)
		}
		time.Sleep(20 * time.Millisecond)
	}
	// A NetBox without the fields takes the pass and writes nothing for them.
	if err := nb.Record(context.Background(), pass("SW-2", one, two)); err != nil {
		t.Fatal(err)
	}
	if cf := f.bySerial("SW-2").CustomFields; cf["dbx_hash"] != nil || cf["attest_verdict"] != StatusAttested {
		t.Fatalf("a NetBox with no dbx field: %+v", cf)
	}
}

func journalHas(f *fakeNetBox, s string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.ContainsFunc(f.journal, func(j string) bool { return strings.Contains(j, s) })
}

var _ = os.Stat
