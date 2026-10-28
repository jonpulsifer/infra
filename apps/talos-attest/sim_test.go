//go:build cgo

// The end-to-end tests run the real client against the real server with a
// software TPM whose PCRs replay riptide's event log, and whose NV holds EK
// certificates from a test manufacturer. They need cgo for the simulator.
package main

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/go-attestation/attest"
	"github.com/google/go-tpm-tools/simulator"
	"github.com/google/go-tpm/legacy/tpm2"
	"github.com/google/go-tpm/tpmutil"

	"github.com/jonpulsifer/infra/apps/talos-attest/client"
	"github.com/jonpulsifer/infra/apps/talos-attest/protocol"
)

const (
	simSerial = "SIM-0001"
	simMAC    = "02:00:00:00:00:01"
)

type harness struct {
	t        *testing.T
	sim      *simulator.Simulator
	v        *Verifier
	srv      *Server
	ts       *httptest.Server
	eventLog []byte
	hashes   map[string]string
	tamper   func(*protocol.EvidenceRequest)
}

type harnessOpts struct {
	eventLog   string
	policy     func(*Policy)
	inventory  func(rsa, ecc string) string
	foreignMfr bool
}

func defaultInventory(rsa, ecc string) string {
	return fmt.Sprintf("machines:\n  testbox:\n    serial: %s\n    mac: %q\n    tpm: \"2.0\"\n    ek_hash: %s\n    ek_hash_ecc: %s\n", simSerial, simMAC, rsa, ecc)
}

func newHarness(t *testing.T, o harnessOpts) *harness {
	t.Helper()
	if o.eventLog == "" {
		o.eventLog = "testdata/riptide-eventlog.bin"
	}
	if o.inventory == nil {
		o.inventory = defaultInventory
	}
	if o.policy == nil {
		// riptide's log is a disk boot of Talos, not HookOS.
		o.policy = func(p *Policy) { p.RequiredAuthorities = nil }
	}
	sim, err := simulator.Get()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { sim.Close() })
	h := &harness{t: t, sim: sim, eventLog: readFile(t, o.eventLog), hashes: map[string]string{}}

	el, err := attest.ParseEventLog(h.eventLog)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range el.Events(attest.HashSHA256) {
		if e.Index <= 7 {
			if err := tpm2.PCRExtend(sim, tpmutil.Handle(e.Index), tpm2.AlgSHA256, e.Digest, ""); err != nil {
				t.Fatal(err)
			}
		}
	}

	mfr := newTestCA(t, "Test TPM Maker", nil, 1)
	for _, c := range []struct {
		alg  string
		nv   uint32
		tmpl tpm2.Public
	}{{"rsa", 0x01c00002, client.EKTemplateRSA}, {"ecc", 0x01c0000a, client.EKTemplateECC}} {
		hnd, pub, err := tpm2.CreatePrimary(sim, tpm2.HandleEndorsement, tpm2.PCRSelection{}, "", "", c.tmpl)
		if err != nil {
			t.Fatal(err)
		}
		_ = tpm2.FlushContext(sim, hnd)
		if h.hashes[c.alg], err = EKHash(pub); err != nil {
			t.Fatal(err)
		}
		writeSimNV(t, sim, c.nv, mfr.issueEK(t, pub))
	}

	roots := &EKRoots{roots: x509.NewCertPool(), intermediates: x509.NewCertPool()}
	if o.foreignMfr {
		roots.Add(newTestCA(t, "Another TPM Maker", nil, 1).cert)
	} else {
		roots.Add(mfr.cert)
	}
	dir := t.TempDir()
	invPath := filepath.Join(dir, "machines.yaml")
	if err := os.WriteFile(invPath, []byte(o.inventory(h.hashes["rsa"], h.hashes["ecc"])), 0o600); err != nil {
		t.Fatal(err)
	}
	inv, err := LoadInventory(invPath)
	if err != nil {
		t.Fatal(err)
	}
	policy := loadPolicy(t)
	o.policy(policy)
	store, err := OpenStore(filepath.Join(dir, "state"))
	if err != nil {
		t.Fatal(err)
	}
	h.v = &Verifier{
		Inventory: inv, Roots: roots, Policy: policy, CA: devIDCA(t), Store: store,
		Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Now: time.Now, SessionTTL: time.Minute,
	}
	h.srv = &Server{V: h.v, Log: h.v.Log, Approvers: map[string]bool{"owner@example.com": true}, Client: http.DefaultClient}
	h.ts = httptest.NewServer(h.tamperEvidence(h.srv.Public()))
	t.Cleanup(h.ts.Close)
	return h
}

func writeSimNV(t *testing.T, rw io.ReadWriter, index uint32, data []byte) {
	t.Helper()
	attrs := tpm2.AttrOwnerWrite | tpm2.AttrOwnerRead | tpm2.AttrAuthRead | tpm2.AttrNoDA
	if err := tpm2.NVDefineSpace(rw, tpm2.HandleOwner, tpmutil.Handle(index), "", "", nil, attrs, uint16(len(data))); err != nil {
		t.Fatal(err)
	}
	for off := 0; off < len(data); off += 512 {
		if err := tpm2.NVWrite(rw, tpm2.HandleOwner, tpmutil.Handle(index), "", data[off:min(off+512, len(data))], uint16(off)); err != nil {
			t.Fatal(err)
		}
	}
}

// tamperEvidence lets a test rewrite the evidence between client and server.
func (h *harness) tamperEvidence(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if h.tamper != nil && strings.HasSuffix(r.URL.Path, "/evidence") {
			var req protocol.EvidenceRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				h.t.Fatal(err)
			}
			h.tamper(&req)
			b, _ := json.Marshal(req)
			r.Body = io.NopCloser(bytes.NewReader(b))
			r.ContentLength = int64(len(b))
		}
		next.ServeHTTP(w, r)
	})
}

func (h *harness) run(serial, mac string) (*client.Result, error) {
	return client.Run(context.Background(), h.sim, client.Config{
		BaseURL:  h.ts.URL,
		Machine:  protocol.Machine{Serial: serial, UUID: "4c4c4544-0000-0000-0000-000000000000", MAC: mac},
		EventLog: h.eventLog,
		StoreNV:  true,
	})
}

func (h *harness) get(path string) (int, []byte) {
	resp, err := http.Get(h.ts.URL + path)
	if err != nil {
		h.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b
}

func TestAttestPassesAndServesTheDevID(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	res, err := h.run(simSerial, simMAC)
	if err != nil {
		t.Fatal(err)
	}
	if res.Verdict.Verdict != protocol.VerdictPass || len(res.NVIndexes) != 2 {
		t.Fatalf("result %+v", res)
	}
	ldevid, err := x509.ParseCertificate(res.Verdict.LDevIDCert)
	if err != nil {
		t.Fatal(err)
	}
	if ldevid.Subject.CommonName != "testbox" || ldevid.Subject.SerialNumber != simSerial {
		t.Fatalf("LDevID subject %s", ldevid.Subject)
	}

	rec, ok, err := h.v.Store.Record("testbox")
	if err != nil || !ok || rec.Status != StatusAttested || !rec.Confirmed || len(rec.BootApplications) != 2 {
		t.Fatalf("record %+v %v %v", rec, ok, err)
	}

	code, body := h.get("/devid/" + strings.ToLower(simSerial))
	if code != http.StatusOK {
		t.Fatalf("GET /devid: %d %s", code, body)
	}
	var d protocol.DevID
	if err := json.Unmarshal(body, &d); err != nil {
		t.Fatal(err)
	}
	if d.Machine != "testbox" || d.SRK != protocol.SRKECCHighRange || !strings.Contains(d.LDevIDCert, "BEGIN CERTIFICATE") || len(d.EKHashes) != 2 || !d.RSAEKCert {
		t.Fatalf("devid %+v", d)
	}
	// The field names images/spire-agent-tpm/devid-init reads.
	for _, field := range []string{`"ldevid_cert_pem"`, `"ldevid_pub_blob_b64"`, `"ldevid_priv_blob_b64"`} {
		if !strings.Contains(string(body), field) {
			t.Fatalf("GET /devid lacks %s", field)
		}
	}
	code, body = h.get("/verdict/" + simSerial)
	var st protocol.Status
	if err := json.Unmarshal(body, &st); err != nil || code != http.StatusOK || st.Status != protocol.StatusAttested || st.Node != "testbox" || st.UUID == "" || !st.AttestedAt.Equal(rec.AttestedAt) {
		t.Fatalf("GET /verdict: %d %s", code, body)
	}
	if code, _ := h.get("/verdict/UNKNOWN"); code != http.StatusNotFound {
		t.Fatalf("an unknown serial's verdict answered %d", code)
	}

	// The blobs load under the SRK SPIRE's agent recreates, and hold the
	// key the LDevID certificate names.
	srk, _, err := tpm2.CreatePrimary(h.sim, tpm2.HandleOwner, tpm2.PCRSelection{}, "", "", client.SRKTemplate)
	if err != nil {
		t.Fatal(err)
	}
	defer tpm2.FlushContext(h.sim, srk)
	key, _, err := tpm2.Load(h.sim, srk, "", d.LDevIDPublic, d.LDevIDPrivate)
	if err != nil {
		t.Fatalf("load the LDevID blobs: %v", err)
	}
	defer tpm2.FlushContext(h.sim, key)
	pub, _, _, err := tpm2.ReadPublic(h.sim, key)
	if err != nil {
		t.Fatal(err)
	}
	loaded, _ := pub.Key()
	want, _ := x509.MarshalPKIXPublicKey(ldevid.PublicKey)
	got, _ := x509.MarshalPKIXPublicKey(loaded)
	if !bytes.Equal(want, got) {
		t.Fatal("the LDevID blobs hold another key than the certificate")
	}

	nv, err := tpm2.NVReadEx(h.sim, tpmutil.Handle(protocol.NVLDevIDCert), tpm2.HandleOwner, "", 0)
	if err != nil || !bytes.Equal(nv, res.Verdict.LDevIDCert) {
		t.Fatalf("NV LDevID certificate: %v", err)
	}

	if code, raw := h.get("/devid/" + simSerial + "/ldevid.priv"); code != http.StatusOK || !bytes.Equal(raw, d.LDevIDPrivate) {
		t.Fatalf("raw ldevid.priv: %d", code)
	}
	if code, _ := h.get("/devid/" + simSerial + "/record.json"); code != http.StatusNotFound {
		t.Fatalf("a file outside the served set answered %d", code)
	}

	// An anchor that did not run the attestation asks its peers.
	peer := httptest.NewServer(h.srv.DevIDHandler())
	defer peer.Close()
	emptyStore, _ := OpenStore(t.TempDir())
	other := &Server{V: &Verifier{Inventory: h.v.Inventory, Store: emptyStore, Log: h.v.Log}, Log: h.v.Log, Peers: []string{peer.URL}, Client: http.DefaultClient}
	rr := httptest.NewRecorder()
	other.DevIDHandler().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/devid/"+simSerial, nil))
	if rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), "testbox") {
		t.Fatalf("peer lookup: %d %s", rr.Code, rr.Body.String())
	}
	rr = httptest.NewRecorder()
	other.DevIDHandler().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/devid/"+simSerial+"?local=1", nil))
	if rr.Code != http.StatusNotFound {
		t.Fatalf("a local-only lookup asked its peers: %d", rr.Code)
	}

	metrics, err := h.v.Metrics()
	if err != nil || !strings.Contains(metrics, `talos_attest_machine_status{machine="testbox",status="attested"} 1`) {
		t.Fatalf("metrics: %v\n%s", err, metrics)
	}

	// A passed session cannot be replayed.
	if _, err := h.v.Evidence(context.Background(), "no-such-session", protocol.EvidenceRequest{}); reasonOf(err) != reasonSession {
		t.Fatalf("unknown session: %v", err)
	}
}

func TestAttestRefusals(t *testing.T) {
	flip := func(b []byte) { b[len(b)-1] ^= 0xff }
	cases := []struct {
		name    string
		opts    harnessOpts
		serial  string
		mac     string
		tamper  func(*protocol.EvidenceRequest)
		reason  string
		noStore bool
	}{
		{name: "unknown serial", serial: "NOT-IN-INVENTORY", reason: reasonUnknownMachine, noStore: true},
		{name: "MAC is not the inventory's", mac: "02:00:00:00:00:99", reason: reasonMACMismatch},
		{name: "EK hash differs from the inventory", opts: harnessOpts{inventory: func(_, ecc string) string {
			return defaultInventory(strings.Repeat("0", 64), ecc)
		}}, reason: reasonEKHash},
		{name: "EK certificate from an unpinned maker", opts: harnessOpts{foreignMfr: true}, reason: reasonEKChain},
		{name: "credential not activated", tamper: func(r *protocol.EvidenceRequest) { r.Activated[0].Secret = make([]byte, 32) }, reason: reasonActivation},
		{name: "quote signature forged", tamper: func(r *protocol.EvidenceRequest) { flip(r.Quote.Signature) }, reason: reasonQuote},
		{name: "PCR value is not the quoted one", tamper: func(r *protocol.EvidenceRequest) { flip(r.PCRs[4].Digest) }, reason: reasonQuote},
		{name: "event log from another boot", tamper: func(r *protocol.EvidenceRequest) {
			r.EventLog = readFile(t, "testdata/optiplex-eventlog.bin")
		}, reason: reasonEventLog},
		{name: "boot path is not HookOS", opts: harnessOpts{policy: func(*Policy) {}}, reason: reasonPolicy},
		{name: "Secure Boot off", opts: harnessOpts{eventLog: "testdata/optiplex-eventlog.bin"}, reason: reasonPolicy},
		{name: "LDevID is not the certified key", tamper: func(r *protocol.EvidenceRequest) { r.LDevID.Public = r.AKBlobs.Public }, reason: reasonLDevID},
		{name: "LDevID blobs are another key", tamper: func(r *protocol.EvidenceRequest) { r.LDevIDBlobs.Public = r.AKBlobs.Public }, reason: reasonLDevID},
		{name: "AK blobs are another key", tamper: func(r *protocol.EvidenceRequest) { r.AKBlobs.Public = r.LDevIDBlobs.Public }, reason: reasonLDevID},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t, c.opts)
			h.tamper = c.tamper
			serial, mac := simSerial, simMAC
			if c.serial != "" {
				serial = c.serial
			}
			if c.mac != "" {
				mac = c.mac
			}
			_, err := h.run(serial, mac)
			var refused *client.RefusedError
			if !errors.As(err, &refused) {
				t.Fatalf("got %v, want a refusal", err)
			}
			if refused.Status != http.StatusForbidden || refused.Verdict.Verdict != protocol.VerdictQuarantine || refused.Verdict.Reason != c.reason {
				t.Fatalf("refusal %d %+v, want %s", refused.Status, refused.Verdict, c.reason)
			}
			rec, ok, err := h.v.Store.Record("testbox")
			if err != nil {
				t.Fatal(err)
			}
			if c.noStore {
				if ok {
					t.Fatalf("an unknown machine got a record: %+v", rec)
				}
				return
			}
			if !ok || rec.Status != StatusQuarantined || rec.Reason != c.reason {
				t.Fatalf("record %+v", rec)
			}
			if code, _ := h.get("/devid/" + simSerial); code != http.StatusNotFound {
				t.Fatalf("a quarantined machine's DevID answered %d", code)
			}
			if code, body := h.get("/verdict/" + simSerial); code != http.StatusOK || !strings.Contains(string(body), `"status":"quarantined"`) {
				t.Fatalf("a quarantined machine's verdict: %d %s", code, body)
			}
		})
	}
}

type fixedPin string

func (p fixedPin) EKHash(context.Context, string) (string, error) { return string(p), nil }

// With no hash in git, NetBox's ek_hash pins the RSA EK.
func TestNetBoxPinsTheEK(t *testing.T) {
	bare := func(_, _ string) string {
		return fmt.Sprintf("machines:\n  testbox:\n    serial: %s\n    mac: %q\n", simSerial, simMAC)
	}
	h := newHarness(t, harnessOpts{inventory: bare})
	h.v.Pins = fixedPin(h.hashes["rsa"])
	if res, err := h.run(simSerial, simMAC); err != nil || res.Verdict.Verdict != protocol.VerdictPass {
		t.Fatalf("pinned by NetBox: %v", err)
	}
	h.v.Pins = fixedPin(strings.Repeat("ab", 32))
	_, err := h.run(simSerial, simMAC)
	var refused *client.RefusedError
	if !errors.As(err, &refused) || refused.Verdict.Reason != reasonEKHash {
		t.Fatalf("another NetBox pin: %v", err)
	}
}

func TestFirstIntakeWaitsForApproval(t *testing.T) {
	h := newHarness(t, harnessOpts{inventory: func(_, _ string) string {
		return fmt.Sprintf("machines:\n  testbox:\n    serial: %s\n    mac: %q\n", simSerial, simMAC)
	}})
	_, err := h.run(simSerial, simMAC)
	var refused *client.RefusedError
	if !errors.As(err, &refused) || refused.Verdict.Verdict != protocol.VerdictPending {
		t.Fatalf("first intake: %v", err)
	}
	rec, _, _ := h.v.Store.Record("testbox")
	if rec.Status != StatusPending || rec.EKHashes["rsa"] != h.hashes["rsa"] {
		t.Fatalf("pending record %+v", rec)
	}

	// The owner approves over the tailnet admin API.
	admin := h.srv.Admin()
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/approve", strings.NewReader(`{"serial":"`+simSerial+`"}`))
	admin.ServeHTTP(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("an approval without a tailnet login answered %d", rr.Code)
	}
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/approve", strings.NewReader(`{"serial":"`+simSerial+`"}`))
	req.Header.Set("Tailscale-User-Login", "Owner@example.com")
	admin.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("approve: %d %s", rr.Code, rr.Body.String())
	}

	res, err := h.run(simSerial, simMAC)
	if err != nil || res.Verdict.Verdict != protocol.VerdictPass {
		t.Fatalf("after approval: %v", err)
	}
}
