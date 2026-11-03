//go:build cgo

package attest

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/x509"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/go-tpm/legacy/tpm2"

	"github.com/jonpulsifer/infra/apps/fleetd/client"
	"github.com/jonpulsifer/infra/apps/fleetd/protocol"
)

// A passed session's AK signs each of the boot's later requests, numbered,
// and the signature verifies with the AK fleetd holds for the machine.
func TestBootRequestsAreSignedByTheSessionsAK(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	var handed []BootSession
	h.v.Booted = func(_ context.Context, s BootSession) { handed = append(handed, s) }
	res, err := h.run(simSerial, simMAC)
	if err != nil {
		t.Fatal(err)
	}
	if res.Session == nil || res.Session.ID == "" || len(res.Session.Nonce) == 0 {
		t.Fatalf("no session in %+v", res)
	}
	if len(handed) != 1 || handed[0].ID != res.Session.ID || handed[0].Machine != "testbox" || !bytes.Equal(handed[0].Nonce, res.Session.Nonce) {
		t.Fatalf("handed over %+v", handed)
	}
	code, body := h.get(strings.Replace(protocol.PathDevID, "{serial}", simSerial, 1))
	if code != http.StatusOK {
		t.Fatalf("devid: %d", code)
	}
	var d protocol.DevID
	if err := json.Unmarshal(body, &d); err != nil {
		t.Fatal(err)
	}
	pub, err := tpm2.DecodePublic(d.AKPublic)
	if err != nil {
		t.Fatal(err)
	}
	key, err := pub.Key()
	if err != nil {
		t.Fatal(err)
	}
	ak := key.(*ecdsa.PublicKey)
	handedKey, err := x509.ParsePKIXPublicKey(handed[0].AK)
	if err != nil || !ak.Equal(handedKey) {
		t.Fatalf("the handed-over AK is not the session's: %v", err)
	}

	var seqs []uint64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req protocol.BootRequest
		// The handler runs off the test's goroutine, so it reports with
		// Errorf and answers, and never stops the goroutine with Fatalf.
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Error(err)
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		route := protocol.PathBootRun
		if strings.HasSuffix(r.URL.Path, "/report") {
			route = protocol.PathBootReport
		}
		if want := strings.Replace(route, "{session}", res.Session.ID, 1); r.URL.Path != want {
			t.Errorf("path %s, want %s", r.URL.Path, want)
		}
		sig, err := tpm2.DecodeSignature(bytes.NewBuffer(req.Signature))
		if err != nil || sig.ECC == nil {
			t.Errorf("signature: %v", err)
			http.Error(w, "bad signature", http.StatusForbidden)
			return
		}
		if !ecdsa.Verify(ak, protocol.BootDigest(res.Session.Nonce, route, req.Seq, req.Report), sig.ECC.R, sig.ECC.S) {
			t.Errorf("request %d is not signed by the session's AK", req.Seq)
		}
		// A request signed for another route or number does not verify.
		if ecdsa.Verify(ak, protocol.BootDigest(res.Session.Nonce, route, req.Seq+1, req.Report), sig.ECC.R, sig.ECC.S) {
			t.Error("the signature verifies for another sequence number")
		}
		seqs = append(seqs, req.Seq)
		if route == protocol.PathBootRun {
			_ = json.NewEncoder(w).Encode(protocol.BootRun{Run: "provision-testbox-1"})
		}
	}))
	defer srv.Close()

	b := &client.Boot{BaseURL: srv.URL, TPM: h.sim, Session: res.Session}
	run, err := b.Run(context.Background())
	if err != nil || run.Run != "provision-testbox-1" {
		t.Fatalf("run %+v, err %v", run, err)
	}
	if err := b.Report(context.Background(), protocol.BootReport{Run: run.Run, Step: protocol.StepWipe, Phase: protocol.PhaseStarted}); err != nil {
		t.Fatal(err)
	}
	if len(seqs) != 2 || seqs[0] != 1 || seqs[1] != 2 {
		t.Errorf("sequence numbers %v, want [1 2]", seqs)
	}
}
