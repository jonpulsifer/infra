package client

import (
	"encoding/binary"
	"fmt"
	"io"
	"strings"

	"github.com/google/go-tpm/legacy/tpm2"
	"github.com/google/go-tpm/tpm2/transport"
)

// TPMReport is what Inspect found: the TPM's identity, the EKs an intake
// sends or the reason it would fail, and for each Low Range profile its NV
// indexes and the EK discovery makes from them.
type TPMReport struct {
	Manufacturer, Vendor, Firmware, Spec string
	// Intake and IntakeErr are what DiscoverEKs answers, and IntakeNote
	// what an intake logs about High Range certificates.
	Intake     []*EK
	IntakeErr  error
	IntakeNote string
	Profiles   []ProfileReport
	// HighRange holds the High Range EK certificate indexes, which this
	// client does not use.
	HighRange    []uint32
	HighRangeErr error
}

// ProfileReport is one profile's indexes, and the EK discovery resolved or
// the reason it did not.
type ProfileReport struct {
	Alg, Name             string
	Cert, Template, Nonce NVState
	EK                    *EK
	Err                   error
}

// NVState is what TPM2_NV_ReadPublic says of one index.
type NVState struct {
	Index   uint32
	Defined bool
	Size    int
	Err     error
}

// Inspect reads what EK discovery depends on, for qualifying a platform. It
// writes no NV and makes no persistent object; each EK it creates is
// transient and flushed.
func Inspect(rw io.ReadWriter) (*TPMReport, error) {
	r, err := tpmIdentity(rw)
	if err != nil {
		return nil, err
	}
	r.Intake, r.IntakeErr = DiscoverEKs(rw)
	if r.IntakeErr == nil {
		r.IntakeNote = HighRangeNote(rw, r.Intake)
	}
	tpm := transport.FromReadWriter(rw)
	for _, p := range ekProfiles {
		pr := ProfileReport{Alg: p.alg, Name: p.name, Cert: probeNV(tpm, p.cert), Template: probeNV(tpm, p.template), Nonce: probeNV(tpm, p.nonce)}
		pr.EK, pr.Err = DiscoverEK(rw, p.alg)
		r.Profiles = append(r.Profiles, pr)
	}
	r.HighRange, r.HighRangeErr = HighRangeEKCerts(rw)
	return r, nil
}

func probeNV(tpm transport.TPM, index uint32) NVState {
	_, pub, err := nvPublic(tpm, index)
	s := NVState{Index: index, Defined: pub != nil, Err: err}
	if pub != nil {
		s.Size = int(pub.DataSize)
	}
	return s
}

func tpmIdentity(rw io.ReadWriter) (*TPMReport, error) {
	vals, _, err := tpm2.GetCapability(rw, tpm2.CapabilityTPMProperties, uint32(tpm2.FirmwareVersion2-tpm2.FamilyIndicator+1), uint32(tpm2.FamilyIndicator))
	if err != nil {
		return nil, fmt.Errorf("read the TPM's properties: %w", err)
	}
	props := map[tpm2.TPMProp]uint32{}
	for _, v := range vals {
		if p, ok := v.(tpm2.TaggedProperty); ok {
			props[p.Tag] = p.Value
		}
	}
	fw1, fw2 := props[tpm2.FirmwareVersion1], props[tpm2.FirmwareVersion2]
	rev := props[tpm2.SpecRevision]
	return &TPMReport{
		Manufacturer: propString(props[tpm2.Manufacturer]),
		Vendor:       propString(props[tpm2.VendorString1], props[tpm2.VendorString2], props[tpm2.VendorString3], props[tpm2.VendorString4]),
		Firmware:     fmt.Sprintf("%d.%d.%d.%d", fw1>>16, fw1&0xffff, fw2>>16, fw2&0xffff),
		Spec:         fmt.Sprintf("family %s level %d revision %d.%02d", propString(props[tpm2.FamilyIndicator]), props[tpm2.SpecLevel], rev/100, rev%100),
	}, nil
}

// propString is the ASCII the TPM packs into property values, four bytes
// each, without its NUL padding.
func propString(vals ...uint32) string {
	var b []byte
	for _, v := range vals {
		b = binary.BigEndian.AppendUint32(b, v)
	}
	return strings.TrimSpace(strings.ReplaceAll(string(b), "\x00", ""))
}
