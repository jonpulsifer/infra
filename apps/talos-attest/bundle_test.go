package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"
)

// The anchors issue under their own CAs. A leaf from any issuing CA in the
// bundle verifies here; one from outside the bundle does not.
func TestVerifyLeafAcceptsEveryIssuerInTheBundle(t *testing.T) {
	root := newTestCA(t, "Test Root", nil, 2)
	inter := newTestCA(t, "Test Intermediate", root, 1)
	spore := newTestCA(t, "FML DevID folly spore CA", inter, 0)
	capsule := newTestCA(t, "FML DevID folly capsule CA", inter, 0)
	anotherRoot := newTestCA(t, "Another Root", nil, 1)
	stranger := newTestCA(t, "Another DevID CA", anotherRoot, 0)
	mine, err := NewCA(spore.key, []*x509.Certificate{spore.cert, inter.cert, root.cert}, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	theirs, err := NewCA(capsule.key, []*x509.Certificate{capsule.cert, inter.cert, root.cert}, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	foreign, err := NewCA(stranger.key, []*x509.Certificate{stranger.cert, anotherRoot.cert}, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	now := time.Now()
	subject := Subject{Machine: "riptide", Serial: "MXL0172Q6L", Class: "worker-g5"}
	fromCapsule, _ := theirs.Issue(key.Public(), subject, "LDevID", now)
	fromSpore, _ := mine.Issue(key.Public(), subject, "LDevID", now)
	fromStranger, _ := foreign.Issue(key.Public(), subject, "LDevID", now)

	if _, err := mine.VerifyLeaf(string(theirs.LeafPEM(fromCapsule)), "riptide", "MXL0172Q6L", now); err == nil {
		t.Fatal("a leaf from a CA outside the bundle verified")
	}
	// The bundle: the site's issuing CAs, as terraform/pki/certs/folly-devid-ca.pem holds them.
	if err := mine.AddIssuers([]*x509.Certificate{spore.cert, capsule.cert}); err != nil {
		t.Fatal(err)
	}
	for name, pemChain := range map[string]string{"spore": string(mine.LeafPEM(fromSpore)), "capsule": string(theirs.LeafPEM(fromCapsule))} {
		if _, err := mine.VerifyLeaf(pemChain, "riptide", "MXL0172Q6L", now); err != nil {
			t.Fatalf("a leaf from %s's CA: %v", name, err)
		}
	}
	if _, err := mine.VerifyLeaf(string(foreign.LeafPEM(fromStranger)), "riptide", "MXL0172Q6L", now); err == nil {
		t.Fatal("a leaf from a CA outside the bundle verified")
	}
	if err := mine.AddIssuers([]*x509.Certificate{stranger.cert}); err == nil {
		t.Fatal("an issuing CA that does not chain to the root was admitted")
	}
	if len(mine.Issuers) != 2 {
		t.Fatalf("%d issuers; the own CA must not be listed twice", len(mine.Issuers))
	}
}

// A pass this anchor issued before NetBox had the verdict fields is written
// there, once, and never over a verdict NetBox already holds.
func TestBackfillWritesAnchorPassesToEmptyNetBoxVerdicts(t *testing.T) {
	f := newFakeNetBox(t)
	s, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	var audit strings.Builder
	v := &Verifier{NetBox: f.client(), Store: s, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Now: time.Now, Audit: &Audit{W: &audit, Site: "folly"}}
	at := time.Date(2026, 10, 28, 23, 3, 6, 0, time.UTC)
	files := map[string][]byte{}
	for _, name := range ServedFiles {
		files[name] = []byte("x")
	}
	// riptide: attested by this anchor before ek_proven existed, with its files here.
	f.add("riptide", "MXL0172Q6L", "active", "38:22:e2:2d:96:44", nil)
	if err := s.Save(Record{Machine: "riptide", Serial: "MXL0172Q6L", Status: StatusAttested, LDevIDSerial: "0a", LAKSerial: "0b", AttestedAt: at, UpdatedAt: at}, files); err != nil {
		t.Fatal(err)
	}
	// swell: NetBox already holds a verdict.
	f.add("swell", "SW-1", "active", "", map[string]any{"attest_verdict": "quarantined: policy"})
	if err := s.Save(Record{Machine: "swell", Serial: "SW-1", Status: StatusAttested, EKProven: true, LDevIDSerial: "0c", LAKSerial: "0d", AttestedAt: at, UpdatedAt: at}, files); err != nil {
		t.Fatal(err)
	}
	// surge: adopted from a peer, stamped with its issue time; not this anchor's to write.
	f.add("surge", "SU-1", "active", "", nil)
	if err := s.Save(Record{Machine: "surge", Serial: "SU-1", Status: StatusAttested, LDevIDNotBefore: at, LDevIDSerial: "0e", LAKSerial: "0f", AttestedAt: at, UpdatedAt: at}, files); err != nil {
		t.Fatal(err)
	}
	// shoal: a record with no files, not an intake here.
	f.add("shoal", "SH-1", "active", "", nil)
	if err := s.Save(Record{Machine: "shoal", Serial: "SH-1", Status: StatusAttested, LDevIDSerial: "10", LAKSerial: "11", AttestedAt: at, UpdatedAt: at}, nil); err != nil {
		t.Fatal(err)
	}

	v.BackfillNetBox(context.Background())
	if d := f.bySerial("MXL0172Q6L"); d.Patches != 1 || d.CustomFields["attest_verdict"] != StatusAttested || d.CustomFields["last_attested"] != "2026-10-28T23:03:06Z" || d.CustomFields["ldevid_serial"] != "0a" || d.CustomFields["lak_serial"] != "0b" || d.Status != "active" {
		t.Fatalf("riptide after the backfill: %s %+v (%d writes)", d.Status, d.CustomFields, d.Patches)
	}
	if d := f.bySerial("SW-1"); d.Patches != 0 || d.CustomFields["attest_verdict"] != "quarantined: policy" {
		t.Fatalf("a verdict NetBox held was overwritten: %+v", d.CustomFields)
	}
	for _, serial := range []string{"SU-1", "SH-1"} {
		if d := f.bySerial(serial); d.Patches != 0 {
			t.Fatalf("%s was backfilled from a record that is not this anchor's intake", serial)
		}
	}
	if !strings.Contains(audit.String(), `"node":"riptide","serial":"MXL0172Q6L","status":"backfilled"`) {
		t.Fatalf("no audit line for the backfill:\n%s", audit.String())
	}
	// A second pass writes nothing more.
	v.BackfillNetBox(context.Background())
	if d := f.bySerial("MXL0172Q6L"); d.Patches != 1 {
		t.Fatalf("the backfill wrote again: %d writes", d.Patches)
	}
}
