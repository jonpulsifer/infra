package client

import "github.com/google/go-tpm/legacy/tpm2"

// The TCG EK credential profile's low-range EK templates (L-1 RSA 2048 and
// L-2 ECC NIST P-256), which the manufacturer's EK certificates certify.
var (
	ekPolicyA = []byte{
		0x83, 0x71, 0x97, 0x67, 0x44, 0x84, 0xB3, 0xF8, 0x1A, 0x90, 0xCC, 0x8D,
		0x46, 0xA5, 0xD7, 0x24, 0xFD, 0x52, 0xD7, 0x6E, 0x06, 0x52, 0x0B, 0x64,
		0xF2, 0xA1, 0xDA, 0x1B, 0x33, 0x14, 0x69, 0xAA,
	}
	ekAttributes = tpm2.FlagFixedTPM | tpm2.FlagFixedParent | tpm2.FlagSensitiveDataOrigin |
		tpm2.FlagAdminWithPolicy | tpm2.FlagRestricted | tpm2.FlagDecrypt

	EKTemplateRSA = tpm2.Public{
		Type:       tpm2.AlgRSA,
		NameAlg:    tpm2.AlgSHA256,
		Attributes: ekAttributes,
		AuthPolicy: ekPolicyA,
		RSAParameters: &tpm2.RSAParams{
			Symmetric:  &tpm2.SymScheme{Alg: tpm2.AlgAES, KeyBits: 128, Mode: tpm2.AlgCFB},
			KeyBits:    2048,
			ModulusRaw: make([]byte, 256),
		},
	}
	EKTemplateECC = tpm2.Public{
		Type:       tpm2.AlgECC,
		NameAlg:    tpm2.AlgSHA256,
		Attributes: ekAttributes,
		AuthPolicy: ekPolicyA,
		ECCParameters: &tpm2.ECCParams{
			Symmetric: &tpm2.SymScheme{Alg: tpm2.AlgAES, KeyBits: 128, Mode: tpm2.AlgCFB},
			CurveID:   tpm2.CurveNISTP256,
			Point:     tpm2.ECPoint{XRaw: make([]byte, 32), YRaw: make([]byte, 32)},
		},
	}

	// SRKTemplate is the parent of the AK and the LDevID: the H-2 template
	// (ECC NIST P-256 storage key, empty unique), the one SPIRE's tpm_devid
	// agent recreates to load an ECC DevID. A TPM derives the same key from
	// it until the TPM is cleared, so it is never made persistent.
	SRKTemplate = tpm2.Public{
		Type:       tpm2.AlgECC,
		NameAlg:    tpm2.AlgSHA256,
		Attributes: tpm2.FlagStorageDefault | tpm2.FlagNoDA,
		ECCParameters: &tpm2.ECCParams{
			Symmetric: &tpm2.SymScheme{Alg: tpm2.AlgAES, KeyBits: 128, Mode: tpm2.AlgCFB},
			CurveID:   tpm2.CurveNISTP256,
		},
	}

	// AKTemplate is a restricted ECDSA P-256 signing key: it signs only
	// TPM-made structures, so a quote or a certification it signs is the
	// TPM's own statement.
	AKTemplate = tpm2.Public{
		Type:       tpm2.AlgECC,
		NameAlg:    tpm2.AlgSHA256,
		Attributes: tpm2.FlagSignerDefault | tpm2.FlagNoDA,
		ECCParameters: &tpm2.ECCParams{
			Sign:    &tpm2.SigScheme{Alg: tpm2.AlgECDSA, Hash: tpm2.AlgSHA256},
			CurveID: tpm2.CurveNISTP256,
		},
	}

	// LDevIDTemplate is an unrestricted ECDSA P-256 signing key that cannot
	// leave the TPM, as the TCG device identity specification describes an
	// LDevID.
	LDevIDTemplate = tpm2.Public{
		Type:    tpm2.AlgECC,
		NameAlg: tpm2.AlgSHA256,
		Attributes: tpm2.FlagFixedTPM | tpm2.FlagFixedParent | tpm2.FlagSensitiveDataOrigin |
			tpm2.FlagUserWithAuth | tpm2.FlagSign | tpm2.FlagNoDA,
		ECCParameters: &tpm2.ECCParams{
			Sign:    &tpm2.SigScheme{Alg: tpm2.AlgECDSA, Hash: tpm2.AlgSHA256},
			CurveID: tpm2.CurveNISTP256,
		},
	}
)

// EK certificate NV indexes, from the TCG registry of reserved handles.
const (
	nvEKCertRSA = 0x01c00002
	nvEKCertECC = 0x01c0000a
)
