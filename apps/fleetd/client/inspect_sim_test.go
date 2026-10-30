//go:build cgo

package client

import (
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"

	"github.com/google/go-tpm/legacy/tpm2"
	"github.com/google/go-tpm/tpmutil"
)

func handles(t *testing.T, rw io.ReadWriter, first tpmutil.Handle) []any {
	t.Helper()
	vals, _, err := tpm2.GetCapability(rw, tpm2.CapabilityHandles, 256, uint32(first))
	if err != nil {
		t.Fatal(err)
	}
	return vals
}

// nvContents reads every NV index whole, with the owner's authorization or
// the index's own password.
func nvContents(t *testing.T, rw io.ReadWriter, passwords map[uint32]string) map[uint32]string {
	t.Helper()
	out := map[uint32]string{}
	for _, v := range handles(t, rw, 0x01000000) {
		h := v.(tpmutil.Handle)
		auth, pw := tpm2.HandleOwner, ""
		if p, ok := passwords[uint32(h)]; ok {
			auth, pw = h, p
		}
		b, err := tpm2.NVReadEx(rw, h, auth, pw, 0)
		if err != nil {
			t.Fatalf("read NV %#x: %v", h, err)
		}
		out[uint32(h)] = fmt.Sprintf("%x", b)
	}
	return out
}

// Inspect reports what an intake sends, each profile's indexes and EK, an
// index it cannot read among them, and leaves the TPM as it found it.
func TestInspectReportsAndChangesNothing(t *testing.T) {
	sim := newSim(t)
	nonce := []byte{1, 2, 3}
	rsaKey := DefaultEKTemplateRSA()
	copy(rsaKey.RSAParameters.ModulusRaw, nonce)
	rsa := makeEK(t, sim, rsaKey)
	defineNV(t, sim, 0x01c00002, ekIndexAttrs, "", certify(t, rsa))
	defineNV(t, sim, 0x01c00003, ekIndexAttrs, "", nonce)
	defineNV(t, sim, 0x01c00004, ekIndexAttrs, "", encode(t, DefaultEKTemplateRSA()))
	defineNV(t, sim, 0x01c0000a, tpm2.AttrAuthWrite|tpm2.AttrAuthRead|tpm2.AttrNoDA, "secret", []byte{0x30})
	defineNV(t, sim, 0x01c00016, ekIndexAttrs, "", []byte{0x30})
	passwords := map[uint32]string{0x01c0000a: "secret"}
	nvBefore, persistentBefore := nvContents(t, sim, passwords), handles(t, sim, 0x81000000)
	lockout := lockoutCounter(t, sim)

	r, err := Inspect(sim)
	if err != nil {
		t.Fatal(err)
	}
	if r.Manufacturer == "" || r.Firmware == "" || !strings.Contains(r.Spec, "family 2.0") {
		t.Errorf("identity %+v", r)
	}
	if !errors.Is(r.IntakeErr, ErrNVPermission) || r.Intake != nil {
		t.Errorf("intake %+v %v; want the ECC certificate's permission failure", r.Intake, r.IntakeErr)
	}
	if len(r.Profiles) != 2 {
		t.Fatalf("profiles %+v", r.Profiles)
	}
	ecc, rsaReport := r.Profiles[0], r.Profiles[1]
	if !ecc.Cert.Defined || ecc.Template.Defined || ecc.Nonce.Defined || !errors.Is(ecc.Err, ErrNVPermission) {
		t.Errorf("ECC %+v", ecc)
	}
	if !rsaReport.Cert.Defined || !rsaReport.Template.Defined || rsaReport.Nonce.Size != len(nonce) || rsaReport.Err != nil ||
		rsaReport.EK.Hash != hashOf(t, rsa) || !rsaReport.EK.TemplateNV || !rsaReport.EK.NonceNV {
		t.Errorf("RSA %+v", rsaReport)
	}
	if r.HighRangeErr != nil || len(r.HighRange) != 1 || r.HighRange[0] != 0x01c00016 {
		t.Errorf("High Range %v %v", r.HighRange, r.HighRangeErr)
	}
	if fmt.Sprint(nvContents(t, sim, passwords)) != fmt.Sprint(nvBefore) || len(handles(t, sim, 0x81000000)) != len(persistentBefore) {
		t.Fatal("Inspect changed the TPM's NV or persistent objects")
	}
	if lockoutCounter(t, sim) != lockout {
		t.Fatal("Inspect changed the lockout counter")
	}
	if transient := handles(t, sim, 0x80000000); len(transient) != 0 {
		t.Fatalf("Inspect left transient objects %v", transient)
	}
}

// On a TPM certified only in the High Range, Inspect's headline is what the
// intake does: the default RSA EK, uncertified, and why.
func TestInspectReportsTheIntakeOfAHighRangeOnlyTPM(t *testing.T) {
	sim := newSim(t)
	defineNV(t, sim, 0x01c00014, ekIndexAttrs, "", certify(t, makeEK(t, sim, DefaultEKTemplateECC())))
	r, err := Inspect(sim)
	if err != nil {
		t.Fatal(err)
	}
	if r.IntakeErr != nil || len(r.Intake) != 1 || r.Intake[0].Alg != "rsa" || r.Intake[0].Cert != nil || !strings.Contains(r.IntakeNote, "0x1c00014") {
		t.Fatalf("intake %+v %v %q", r.Intake, r.IntakeErr, r.IntakeNote)
	}
}
