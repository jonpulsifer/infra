//go:build cgo

package main

import (
	"bytes"
	"context"
	"crypto"
	"crypto/x509"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/go-attestation/attest"
	"github.com/google/go-tpm/legacy/tpm2"
	"github.com/google/go-tpm/tpmutil"

	"github.com/jonpulsifer/infra/apps/talos-attest/client"
	"github.com/jonpulsifer/infra/apps/talos-attest/protocol"
)

// renewalService stands in for the renewal routes: it serves the real DevID
// lookup, and checks the evidence against the LAK on file the way the
// contract says the service does, before it issues the LDevID again.
type renewalService struct {
	h       *harness
	nonce   []byte
	refuse  int
	calls   int
	withLAK bool
	// signer and name, when set, issue as another CA or for another machine.
	signer *CA
	name   string
}

func (r *renewalService) handler() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("GET /devid/", r.h.srv.DevIDHandler())
	mux.HandleFunc("POST "+protocol.PathRenew, func(w http.ResponseWriter, req *http.Request) {
		r.calls++
		var body protocol.RenewRequest
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil || body.Serial != simSerial {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		if r.refuse != 0 {
			w.WriteHeader(r.refuse)
			_ = json.NewEncoder(w).Encode(protocol.Verdict{Verdict: protocol.VerdictQuarantine, Reason: "status"})
			return
		}
		r.nonce = bytes.Repeat([]byte{7}, 32)
		_ = json.NewEncoder(w).Encode(protocol.RenewStart{Session: "s1", Nonce: r.nonce})
	})
	mux.HandleFunc("POST /v1/renew/s1/evidence", func(w http.ResponseWriter, req *http.Request) {
		var ev protocol.RenewEvidence
		if err := json.NewDecoder(req.Body).Decode(&ev); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		out, err := r.check(ev)
		if err != nil {
			http.Error(w, err.Error(), http.StatusForbidden)
			return
		}
		_ = json.NewEncoder(w).Encode(out)
	})
	return mux
}

func (r *renewalService) check(ev protocol.RenewEvidence) (protocol.Renewed, error) {
	d, ok, err := r.h.srv.localDevID(simSerial)
	if err != nil || !ok {
		return protocol.Renewed{}, errors.New("no LAK on file")
	}
	ak, err := attest.ParseAKPublic(d.AKPublic)
	if err != nil {
		return protocol.Renewed{}, err
	}
	var pcrs []attest.PCR
	for _, p := range ev.PCRs {
		pcrs = append(pcrs, attest.PCR{Index: p.Index, Digest: p.Digest, DigestAlg: crypto.SHA256})
	}
	if err := ak.Verify(attest.Quote{Quote: ev.Quote.Quote, Signature: ev.Quote.Signature}, pcrs, r.nonce); err != nil {
		return protocol.Renewed{}, err
	}
	el, err := attest.ParseEventLog(ev.EventLog)
	if err != nil {
		return protocol.Renewed{}, err
	}
	if _, err := el.Verify(pcrs); err != nil {
		return protocol.Renewed{}, err
	}
	cp := attest.CertificationParameters{Public: ev.LDevID.Public, CreateAttestation: ev.LDevID.Attestation, CreateSignature: ev.LDevID.Signature}
	if err := cp.Verify(attest.VerifyOpts{Public: ak.Public, Hash: ak.Hash}); err != nil {
		return protocol.Renewed{}, err
	}
	att, err := tpm2.DecodeAttestationData(ev.LDevID.Attestation)
	if err != nil || !bytes.Equal(att.ExtraData, r.nonce) {
		return protocol.Renewed{}, errors.New("the certification is not qualified by the nonce")
	}
	pub, err := tpm2.DecodePublic(ev.LDevID.Public)
	if err != nil {
		return protocol.Renewed{}, err
	}
	key, err := pub.Key()
	if err != nil {
		return protocol.Renewed{}, err
	}
	ca, name := r.h.v.CA, "testbox"
	if r.signer != nil {
		ca = r.signer
	}
	if r.name != "" {
		name = r.name
	}
	// A minute on: a later expiry than the intake's, while CA.Issue's
	// NotBefore stays in the past.
	later := time.Now().Add(time.Minute)
	ldevid, err := ca.Issue(key, name, simSerial, "LDevID", later)
	if err != nil {
		return protocol.Renewed{}, err
	}
	out := protocol.Renewed{LDevIDCert: string(ca.LeafPEM(ldevid))}
	if r.withLAK {
		lak, err := ca.Issue(ak.Public, name, simSerial, "LAK", later)
		if err != nil {
			return protocol.Renewed{}, err
		}
		out.LAKCert = string(ca.LeafPEM(lak))
	}
	return out, nil
}

func (h *harness) nvCert(index uint32) *x509.Certificate {
	h.t.Helper()
	b, err := tpm2.NVReadEx(h.sim, tpmutil.Handle(index), tpm2.HandleOwner, "", 0)
	if err != nil {
		h.t.Fatal(err)
	}
	c, err := x509.ParseCertificate(b)
	if err != nil {
		h.t.Fatal(err)
	}
	return c
}

func (h *harness) renew(svc *renewalService, before time.Duration) (*client.RenewResult, error) {
	ts := httptest.NewServer(svc.handler())
	h.t.Cleanup(ts.Close)
	roots := x509.NewCertPool()
	roots.AddCert(h.v.CA.Cert)
	return client.Renew(context.Background(), h.sim, client.RenewConfig{
		BaseURL:     ts.URL,
		Serial:      simSerial,
		EventLog:    h.eventLog,
		Roots:       roots,
		RenewBefore: before,
	})
}

func TestRenewWaitsUntilDue(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	if _, err := h.run(simSerial, simMAC); err != nil {
		t.Fatal(err)
	}
	svc := &renewalService{h: h}
	res, err := h.renew(svc, 30*24*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if res.Renewed || svc.calls != 0 || !res.NotAfter.Equal(h.nvCert(protocol.NVLDevIDCert).NotAfter) {
		t.Fatalf("a renewal before it was due: %+v, %d calls", res, svc.calls)
	}
}

func TestRenewStoresTheNewLDevID(t *testing.T) {
	for _, withLAK := range []bool{false, true} {
		t.Run(map[bool]string{false: "LDevID only", true: "with the LAK"}[withLAK], func(t *testing.T) { testRenewStores(t, withLAK) })
	}
}

func testRenewStores(t *testing.T, withLAK bool) {
	h := newHarness(t, harnessOpts{})
	if _, err := h.run(simSerial, simMAC); err != nil {
		t.Fatal(err)
	}
	old, oldLAK := h.nvCert(protocol.NVLDevIDCert), h.nvCert(protocol.NVLAKCert)
	res, err := h.renew(&renewalService{h: h, withLAK: withLAK}, 400*24*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	got := h.nvCert(protocol.NVLDevIDCert)
	if !res.Renewed || !got.NotAfter.Equal(res.NotAfter) || !got.NotAfter.After(old.NotAfter) || got.SerialNumber.Cmp(old.SerialNumber) == 0 {
		t.Fatalf("NV after renewal: %s until %s, result %+v", got.SerialNumber, got.NotAfter, res)
	}
	oldKey, _ := x509.MarshalPKIXPublicKey(old.PublicKey)
	newKey, _ := x509.MarshalPKIXPublicKey(got.PublicKey)
	if !bytes.Equal(oldKey, newKey) {
		t.Fatal("the renewed LDevID certifies another key")
	}
	if lak := h.nvCert(protocol.NVLAKCert); (lak.SerialNumber.Cmp(oldLAK.SerialNumber) != 0) != withLAK {
		t.Fatalf("LAK in NV with withLAK=%v: %s, was %s", withLAK, lak.SerialNumber, oldLAK.SerialNumber)
	}
}

func TestRenewRefusalLeavesNV(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	if _, err := h.run(simSerial, simMAC); err != nil {
		t.Fatal(err)
	}
	old := h.nvCert(protocol.NVLDevIDCert)
	_, err := h.renew(&renewalService{h: h, refuse: http.StatusForbidden}, 400*24*time.Hour)
	var refused *client.RefusedError
	if !errors.As(err, &refused) || refused.Status != http.StatusForbidden {
		t.Fatalf("got %v, want a 403 refusal", err)
	}
	if got := h.nvCert(protocol.NVLDevIDCert); !bytes.Equal(got.Raw, old.Raw) {
		t.Fatal("a refused renewal changed NV")
	}
}

func TestRenewWithoutAnLDevID(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	_, err := h.renew(&renewalService{h: h}, 30*24*time.Hour)
	if !errors.Is(err, client.ErrNoLDevID) {
		t.Fatalf("got %v, want ErrNoLDevID", err)
	}
}

// The routes are plain HTTP, so an answer that does not chain to a pinned
// DevID CA, or names another machine, must not reach NV.
func TestRenewRefusesAnUnpinnedOrMisnamedCertificate(t *testing.T) {
	for name, svc := range map[string]func(h *harness) *renewalService{
		"another CA":      func(h *harness) *renewalService { return &renewalService{h: h, signer: devIDCA(t)} },
		"another CA LAK":  func(h *harness) *renewalService { return &renewalService{h: h, signer: devIDCA(t), withLAK: true} },
		"another machine": func(h *harness) *renewalService { return &renewalService{h: h, name: "otherbox"} },
	} {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t, harnessOpts{})
			if _, err := h.run(simSerial, simMAC); err != nil {
				t.Fatal(err)
			}
			old, oldLAK := h.nvCert(protocol.NVLDevIDCert), h.nvCert(protocol.NVLAKCert)
			if _, err := h.renew(svc(h), 400*24*time.Hour); err == nil {
				t.Fatal("the renewal was accepted")
			}
			if !bytes.Equal(h.nvCert(protocol.NVLDevIDCert).Raw, old.Raw) || !bytes.Equal(h.nvCert(protocol.NVLAKCert).Raw, oldLAK.Raw) {
				t.Fatal("a refused certificate changed NV")
			}
		})
	}
}

// A run that lost the LDevID in NV, as a failed write leaves it, renews on
// the next run while the LAK is there, and an unparseable index counts as
// empty.
func TestRenewRecoversAnEmptyLDevIDIndex(t *testing.T) {
	for name, damage := range map[string]func(h *harness){
		"undefined": func(h *harness) {
			if err := tpm2.NVUndefineSpace(h.sim, "", tpm2.HandleOwner, tpmutil.Handle(protocol.NVLDevIDCert)); err != nil {
				t.Fatal(err)
			}
		},
		"garbage": func(h *harness) {
			if err := tpm2.NVUndefineSpace(h.sim, "", tpm2.HandleOwner, tpmutil.Handle(protocol.NVLDevIDCert)); err != nil {
				t.Fatal(err)
			}
			writeSimNV(t, h.sim, protocol.NVLDevIDCert, bytes.Repeat([]byte{0xff}, 64))
		},
	} {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t, harnessOpts{})
			if _, err := h.run(simSerial, simMAC); err != nil {
				t.Fatal(err)
			}
			damage(h)
			res, err := h.renew(&renewalService{h: h}, 30*24*time.Hour)
			if err != nil || !res.Renewed {
				t.Fatalf("got %+v, %v; want a renewal", res, err)
			}
			if got := h.nvCert(protocol.NVLDevIDCert); !got.NotAfter.Equal(res.NotAfter) {
				t.Fatalf("NV holds an LDevID until %s, the result says %s", got.NotAfter, res.NotAfter)
			}
		})
	}
}
