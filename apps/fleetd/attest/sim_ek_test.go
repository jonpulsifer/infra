//go:build cgo

package attest

import (
	"bytes"
	"errors"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/google/go-attestation/attest"
	"github.com/google/go-tpm/legacy/tpm2"
	"github.com/google/go-tpm/tpmutil"

	"github.com/jonpulsifer/infra/apps/fleetd/client"
	"github.com/jonpulsifer/infra/apps/fleetd/protocol"
)

func marshal(t *testing.T, p tpm2.Public) []byte {
	t.Helper()
	b, err := p.Encode()
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// reboot power-cycles the TPM, which keeps its seeds and NV, and measures
// the boot again.
func (h *harness) reboot() {
	h.t.Helper()
	if err := h.sim.Reset(); err != nil {
		h.t.Fatal(err)
	}
	el, err := attest.ParseEventLog(h.eventLog)
	if err != nil {
		h.t.Fatal(err)
	}
	for _, e := range el.Events(attest.HashSHA256) {
		if e.Index <= 7 {
			if err := tpm2.PCRExtend(h.sim, tpmutil.Handle(e.Index), tpm2.AlgSHA256, e.Digest, ""); err != nil {
				h.t.Fatal(err)
			}
		}
	}
}

// A maker that stores an EK Template and an EK Nonce certifies the keys they
// make. The client recreates those keys, the service's chain and key checks
// pass, and each credential activates.
func TestAttestWithTheMakersEKTemplateAndNonce(t *testing.T) {
	nonce := []byte("the maker's nonce")
	rsaTemplate := client.DefaultEKTemplateRSA()
	rsaTemplate.RSAParameters.ModulusRaw = nil
	rsaKey := client.DefaultEKTemplateRSA()
	copy(rsaKey.RSAParameters.ModulusRaw, nonce)
	eccTemplate := client.DefaultEKTemplateECC()
	eccTemplate.Attributes |= tpm2.FlagNoDA
	h := newHarness(t, harnessOpts{
		ekTemplates: map[string]tpm2.Public{"rsa": rsaKey, "ecc": eccTemplate},
		ekNV: map[uint32][]byte{
			0x01c00003: nonce,
			0x01c00004: marshal(t, rsaTemplate),
			0x01c0000c: marshal(t, eccTemplate),
		},
	})
	res, err := h.run(simSerial, simMAC)
	if err != nil || res.Verdict.Verdict != protocol.VerdictPass {
		t.Fatalf("attest with the maker's templates: %+v %v", res, err)
	}
	d := h.devID(t, simSerial)
	want := []string{h.hashes["ecc"], h.hashes["rsa"]}
	if got := slices.Sorted(slices.Values(d.EKHashes)); !slices.Equal(got, slices.Sorted(slices.Values(want))) || !d.RSAEKCert {
		t.Fatalf("EKs on file %v, want %v", d.EKHashes, want)
	}
}

// A certificate that names another key than the one its template makes is
// the client's refusal: nothing reaches the service.
func TestAttestRefusesAnEKCertificateForAnotherKey(t *testing.T) {
	other := client.DefaultEKTemplateRSA()
	other.RSAParameters.ModulusRaw[0] = 1
	h := newHarness(t, harnessOpts{ekTemplates: map[string]tpm2.Public{"rsa": other}})
	_, err := h.run(simSerial, simMAC)
	var refused *client.RefusedError
	if !errors.Is(err, client.ErrEKCertMismatch) || errors.As(err, &refused) {
		t.Fatalf("got %v, want the client's refusal", err)
	}
	if h.audit.Len() != 0 {
		t.Fatalf("the service heard from the machine:\n%s", h.audit.String())
	}
}

func rsaPinOnly(rsa, _ string) string {
	return fmt.Sprintf("machines:\n  testbox:\n    serial: %s\n    mac: %q\n    tpm: \"2.0\"\n    class: worker-g5\n    ek_hash: %s\n", simSerial, simMAC, rsa)
}

// A TPM without Low Range certificates sends its RSA EK alone. The pin
// admits it, and the credential must still activate.
func TestAPinnedUncertifiedEKStillActivates(t *testing.T) {
	t.Run("activated", func(t *testing.T) {
		h := newHarness(t, harnessOpts{noEKCerts: true, inventory: rsaPinOnly})
		res, err := h.run(simSerial, simMAC)
		if err != nil || res.Verdict.Verdict != protocol.VerdictPass {
			t.Fatalf("pinned uncertified EK: %+v %v", res, err)
		}
		if d := h.devID(t, simSerial); d.RSAEKCert || !slices.Equal(d.EKHashes, []string{h.hashes["rsa"]}) {
			t.Fatalf("EKs on file %+v", d)
		}
	})
	t.Run("High Range certificates alone", func(t *testing.T) {
		h := newHarness(t, harnessOpts{noEKCerts: true, inventory: rsaPinOnly, ekNV: map[uint32][]byte{0x01c00014: {0x30, 0x00}}})
		res, err := h.run(simSerial, simMAC)
		if err != nil || res.Verdict.Verdict != protocol.VerdictPass {
			t.Fatalf("pinned EK beside High Range certificates: %+v %v", res, err)
		}
		if d := h.devID(t, simSerial); d.RSAEKCert || !slices.Equal(d.EKHashes, []string{h.hashes["rsa"]}) {
			t.Fatalf("EKs on file %+v", d)
		}
	})
	t.Run("not activated", func(t *testing.T) {
		h := newHarness(t, harnessOpts{noEKCerts: true, inventory: rsaPinOnly})
		h.tamper = func(r *protocol.EvidenceRequest) { r.Activated[0].Secret = make([]byte, 32) }
		if r := refusal(t, func() error { _, err := h.run(simSerial, simMAC); return err }()); r.Verdict.Reason != reasonActivation {
			t.Fatalf("got %+v", r.Verdict)
		}
	})
}

// After a reboot the node renews with the blobs and LDevID key of its pass,
// and finds the EKs the pass recorded.
func TestTheIdentityRenewsAfterAReboot(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	if _, err := h.run(simSerial, simMAC); err != nil {
		t.Fatal(err)
	}
	before := h.devID(t, simSerial)
	h.reboot()
	h.v.Policies = map[string]*Policy{"talos": loadPolicy(t)}
	h.v.Now = func() time.Time { return time.Now().Add(time.Hour) }
	renewed, err := h.renew(simSerial)
	if err != nil || !renewed.Renewed {
		t.Fatalf("renew after a reboot: %+v %v", renewed, err)
	}
	after := h.devID(t, simSerial)
	if !bytes.Equal(after.LDevIDPrivate, before.LDevIDPrivate) || !bytes.Equal(after.AKPublic, before.AKPublic) || !slices.Equal(after.EKHashes, before.EKHashes) {
		t.Fatal("the renewal changed the keys on file")
	}
	eks, err := client.DiscoverEKs(h.sim)
	if err != nil {
		t.Fatal(err)
	}
	var found []string
	for _, e := range eks {
		found = append(found, e.Hash)
	}
	if !slices.Equal(slices.Sorted(slices.Values(found)), slices.Sorted(slices.Values(before.EKHashes))) {
		t.Fatalf("EKs after the reboot %v, on file %v", found, before.EKHashes)
	}
}
