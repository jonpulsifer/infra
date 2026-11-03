//go:build cgo

package attest

import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jonpulsifer/infra/apps/fleetd/protocol"
)

// secondTPMEKs are the EKs of a TPM that is not the harness's: fresh RSA and
// ECC keys with certificates from the harness TPM's maker, and their hashes.
func secondTPMEKs(t *testing.T, h *harness) ([]protocol.EK, map[string]string) {
	t.Helper()
	r, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	e, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	var eks []protocol.EK
	hashes := map[string]string{}
	for alg, pub := range map[string]crypto.PublicKey{"rsa": &r.PublicKey, "ecc": &e.PublicKey} {
		der, _ := x509.MarshalPKIXPublicKey(pub)
		eks = append(eks, protocol.EK{Public: der, Cert: h.mfr.issueEK(t, pub)})
		hashes[alg], _ = EKHash(pub)
	}
	return eks, hashes
}

// startWith posts a Start for serial with eks.
func startWith(t *testing.T, h *harness, serial string, eks []protocol.EK) (int, string) {
	t.Helper()
	claim := simClaim
	claim.Serial = serial
	b, _ := json.Marshal(protocol.StartRequest{Machine: claim, EKs: eks})
	resp, err := http.Post(h.ts.URL+protocol.PathStart, "application/json", bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var buf bytes.Buffer
	_, _ = buf.ReadFrom(resp.Body)
	return resp.StatusCode, buf.String()
}

func clearBinding(f *fakeNetBox) {
	f.set(simSerial, func(d *fakeDevice) {
		d.CustomFields["approved_ek_hash"], d.CustomFields["approved_ek_hash_ecc"] = nil, nil
	})
}

// A NetBox writer who clears an active node's approved binding and writes
// another TPM's hashes into ek_hash gets nothing: the pins fleetd holds are
// the ones its own record proved, and only the node's own TPM passes.
func TestNetBoxPinsAuthorizeNothing(t *testing.T) {
	h, f := activeNode(t)
	before, _, _ := h.v.Store.Record("testbox")
	issued := strings.Count(h.audit.String(), `"event":"attest.issue"`)

	eks, hashes := secondTPMEKs(t, h)
	clearBinding(f)
	f.set(simSerial, func(d *fakeDevice) {
		d.CustomFields["ek_hash"], d.CustomFields["ek_hash_ecc"] = hashes["rsa"], hashes["ecc"]
	})
	code, body := startWith(t, h, simSerial, eks)
	if code != http.StatusForbidden || !strings.Contains(body, reasonBindingRemoved) || !strings.Contains(body, protocol.VerdictRefused) {
		t.Fatalf("the second TPM: %d %s", code, body)
	}
	rec, ok, _ := h.v.Store.Record("testbox")
	if !ok || rec.Status != StatusAttested || !rec.UpdatedAt.Equal(before.UpdatedAt) {
		t.Fatalf("a refused claim touched the record: %+v", rec)
	}
	if _, waiting, _ := h.v.Store.Pending(simSerial); waiting {
		t.Fatal("a refused claim waits")
	}
	if strings.Count(h.audit.String(), `"event":"attest.issue"`) != issued {
		t.Fatal("a certificate was issued to the second TPM")
	}
	if !strings.Contains(h.audit.String(), `"status":"refused"`) {
		t.Fatalf("no refusal in the audit stream:\n%s", h.audit.String())
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		f.Mu.Lock()
		journaled := strings.Contains(strings.Join(f.journalLines(), "\n"), "not the ones an earlier pass proved")
		f.Mu.Unlock()
		if journaled {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the device was not journaled: %q", f.journalLines())
		}
		time.Sleep(10 * time.Millisecond)
	}

	// The node's own TPM still passes on what it proved, with no binding.
	res, err := h.run(simSerial, simMAC)
	if err != nil || res.Verdict.Verdict != protocol.VerdictPass {
		t.Fatalf("the original TPM: %v", err)
	}
}

// A retired record proves nothing, so the node's own pins refuse too.
func TestARetiredRecordProvesNothing(t *testing.T) {
	h, f := activeNode(t)
	clearBinding(f)
	if err := h.v.Retire(simSerial); err != nil {
		t.Fatal(err)
	}
	r := refusal(t, func() error { _, err := h.run(simSerial, simMAC); return err }())
	if r.Verdict.Reason != reasonBindingRemoved || r.Verdict.Verdict != protocol.VerdictRefused {
		t.Fatalf("a retired record's pins: %+v", r.Verdict)
	}
}

// The proof survives a renewal, which does not pin: the node's TPM still
// passes from HookOS after one, with its binding gone.
func TestTheProofSurvivesARenewal(t *testing.T) {
	h, f := activeNode(t)
	hookOS := h.v.Policies
	h.reboot()
	h.v.Policies = map[string]*Policy{"talos": loadPolicy(t)}
	h.v.Now = func() time.Time { return time.Now().Add(time.Hour) }
	if _, err := h.renew(simSerial); err != nil {
		t.Fatalf("renewal: %v", err)
	}
	h.v.Policies, h.v.Now = hookOS, time.Now
	clearBinding(f)
	h.reboot()
	if res, err := h.run(simSerial, simMAC); err != nil || res.Verdict.Verdict != protocol.VerdictPass {
		t.Fatalf("reboot into HookOS after a renewal: %v", err)
	}
}
