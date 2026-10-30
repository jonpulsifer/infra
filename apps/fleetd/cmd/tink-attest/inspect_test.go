package main

import (
	"fmt"
	"strings"
	"testing"

	"github.com/jonpulsifer/infra/apps/fleetd/client"
)

func TestInspectReportNamesEachProfileAndFailure(t *testing.T) {
	var b strings.Builder
	writeReport(&b, platform{"HP", "HP EliteDesk 800 G5 DM", "7PD", "HP", "R21 Ver. 02.19.00", "06/20/2024"}, &client.TPMReport{
		Manufacturer: "IFX", Vendor: "SLB9672", Firmware: "16.13.0.0", Spec: "family 2.0 level 0 revision 1.59",
		Profiles: []client.ProfileReport{
			{Alg: "ecc", Name: "ECC NIST P256", Cert: client.NVState{Index: 0x01c0000a}, Template: client.NVState{Index: 0x01c0000c}, Nonce: client.NVState{Index: 0x01c0000b},
				Err: fmt.Errorf("ECC NIST P256 EK certificate: %w", &client.NVError{Index: 0x01c0000a, Class: client.ErrNVPermission, Err: fmt.Errorf("bad auth")})},
			{Alg: "rsa", Name: "RSA 2048", Cert: client.NVState{Index: 0x01c00002, Defined: true, Size: 1442}, Template: client.NVState{Index: 0x01c00004}, Nonce: client.NVState{Index: 0x01c00003},
				EK: &client.EK{Alg: "rsa", Hash: "abc", Cert: []byte{0x30}}},
		},
		HighRange: []uint32{0x01c00016},
	})
	got := b.String()
	for _, want := range []string{
		"model: HP HP EliteDesk 800 G5 DM (SKU 7PD)",
		"firmware: HP R21 Ver. 02.19.00 (06/20/2024)",
		`tpm: IFX "SLB9672" firmware 16.13.0.0, family 2.0 level 0 revision 1.59`,
		"ek ecc (ECC NIST P256): certificate 0x1c0000a absent, template 0x1c0000c absent, nonce 0x1c0000b absent; FAILED: ECC NIST P256 EK certificate: NV 0x1c0000a: not readable: bad auth",
		"ek rsa (RSA 2048): certificate 0x1c00002 present (1442 bytes), template 0x1c00004 absent, nonce 0x1c00003 absent; EK abc matches its certificate",
		"high range EK certificates: 0x1c00016 (unsupported)",
	} {
		if !strings.Contains(got, want+"\n") {
			t.Errorf("no line %q in\n%s", want, got)
		}
	}
}
