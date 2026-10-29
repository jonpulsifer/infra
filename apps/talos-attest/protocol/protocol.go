// Package protocol is the JSON contract between talos-attest and the tink-attest
// action. Byte fields travel as standard base64, as encoding/json writes them.
// TPM structures keep their TPM wire encoding: Public is a TPMT_PUBLIC, Private
// the body of a TPM2B_PRIVATE, attestations TPMS_ATTEST and signatures
// TPMT_SIGNATURE, the forms go-tpm's legacy tpm2.CreateKey and tpm2.Load use.
package protocol

import "time"

// Paths of the device-facing routes.
const (
	PathStart    = "/v1/attest"
	PathEvidence = "/v1/attest/{session}/evidence"
	PathConfirm  = "/v1/attest/{session}/confirm"
	PathDevID    = "/devid/{serial}"
	PathVerdict  = "/verdict/{serial}"
	// The renewal routes, which a running node reaches on the DevID listener.
	PathRenew         = "/v1/renew"
	PathRenewEvidence = "/v1/renew/{session}/evidence"
)

// Verdicts. A refusal is an answer to a request that proved nothing yet; it
// changes no machine's record.
const (
	VerdictPass       = "pass"
	VerdictQuarantine = "quarantine"
	VerdictPending    = "pending-approval"
	VerdictRefused    = "refused"
)

// Machine is what the host says about itself, from SMBIOS and its NIC. The
// hardware facts fill the NetBox device the service creates on first sight.
type Machine struct {
	Serial       string `json:"serial"`
	UUID         string `json:"uuid"`
	MAC          string `json:"mac"`
	Hostname     string `json:"hostname,omitempty"`
	Manufacturer string `json:"manufacturer,omitempty"`
	Model        string `json:"model,omitempty"`
	SKU          string `json:"sku,omitempty"`
	BIOS         string `json:"bios,omitempty"`
}

// EK is one endorsement key: its DER SubjectPublicKeyInfo and, when the TPM
// holds one in NV, the manufacturer's certificate.
type EK struct {
	Public []byte `json:"public"`
	Cert   []byte `json:"cert,omitempty"`
}

// AK is an attestation key with its creation proof: TPM2_Create's creation
// data and TPM2_CertifyCreation over it, signed by the AK itself.
type AK struct {
	Public            []byte `json:"public"`
	CreateData        []byte `json:"create_data"`
	CreateAttestation []byte `json:"create_attestation"`
	CreateSignature   []byte `json:"create_signature"`
}

// StartRequest opens an attestation.
type StartRequest struct {
	Machine Machine `json:"machine"`
	EKs     []EK    `json:"eks"`
	AK      AK      `json:"ak"`
}

// Challenge is TPM2_MakeCredential output for one EK, bound to the AK's name.
// Credential and Secret keep their TPM2B size prefix.
type Challenge struct {
	EKHash     string `json:"ek_hash"`
	Credential []byte `json:"credential"`
	Secret     []byte `json:"secret"`
}

// StartResponse carries the session, the quote nonce and one challenge per EK.
type StartResponse struct {
	Session    string      `json:"session"`
	Nonce      []byte      `json:"nonce"`
	Challenges []Challenge `json:"challenges"`
	Expires    time.Time   `json:"expires"`
}

// Activated is the secret TPM2_ActivateCredential recovered for one EK.
type Activated struct {
	EKHash string `json:"ek_hash"`
	Secret []byte `json:"secret"`
}

// PCR is one SHA-256 PCR value.
type PCR struct {
	Index  int    `json:"index"`
	Digest []byte `json:"digest"`
}

// Quote is TPM2_Quote output, the nonce as qualifying data.
type Quote struct {
	Quote     []byte `json:"quote"`
	Signature []byte `json:"signature"`
}

// Certified is TPM2_Certify output: the AK's statement, qualified by the nonce,
// that the key with Public lives in the same TPM.
type Certified struct {
	Public      []byte `json:"public"`
	Attestation []byte `json:"attestation"`
	Signature   []byte `json:"signature"`
}

// Blobs is a key wrapped by its parent, the TPM2_Create output that only the
// TPM that made it can load again.
type Blobs struct {
	Public  []byte `json:"public"`
	Private []byte `json:"private"`
}

// EvidenceRequest answers the challenges and carries the boot evidence and
// the new LDevID key.
type EvidenceRequest struct {
	Activated []Activated `json:"activated"`
	Quote     Quote       `json:"quote"`
	PCRs      []PCR       `json:"pcrs"`
	EventLog  []byte      `json:"event_log"`
	LDevID    Certified   `json:"ldevid"`
	// The SRK-wrapped blobs, kept so the SPIRE agent can load the keys
	// after the disk is wiped.
	LDevIDBlobs Blobs `json:"ldevid_blobs"`
	AKBlobs     Blobs `json:"ak_blobs"`
}

// Verdict is the service's answer to evidence, and its refusal body.
type Verdict struct {
	Verdict string   `json:"verdict"`
	Reason  string   `json:"reason,omitempty"`
	Detail  []string `json:"detail,omitempty"`
	// DER certificates, on a pass.
	LDevIDCert []byte   `json:"ldevid_cert,omitempty"`
	LAKCert    []byte   `json:"lak_cert,omitempty"`
	Chain      [][]byte `json:"chain,omitempty"`
}

// RenewRequest opens a renewal for the machine with this SMBIOS serial. The
// service answers 404 when it holds no LAK for the serial, and 403 when the
// machine's status forbids a renewal.
type RenewRequest struct {
	Serial string `json:"serial"`
}

// RenewStart carries the renewal's session and its quote nonce.
type RenewStart struct {
	Session string `json:"session"`
	Nonce   []byte `json:"nonce"`
}

// RenewEvidence is a running node's boot evidence, signed by the LAK the
// service has on file: a quote over PCRs 0 to 7 qualified by the nonce, the
// PCR values, the event log, and the LDevID key certified by the LAK with the
// nonce. The service replays the log as at intake and certifies the key
// again, which may be the key it certified before.
type RenewEvidence struct {
	Quote    Quote     `json:"quote"`
	PCRs     []PCR     `json:"pcrs"`
	EventLog []byte    `json:"event_log"`
	LDevID   Certified `json:"ldevid"`
}

// Renewed is a renewal's answer. Each PEM holds the leaf, then the DevID CA.
// LAKCert is optional: a service that issues only the LDevID again leaves it
// out.
type Renewed struct {
	LDevIDCert string `json:"ldevid_cert_pem"`
	LAKCert    string `json:"lak_cert_pem,omitempty"`
}

// ConfirmRequest reports that the host stored its certificates.
type ConfirmRequest struct {
	NVIndexes []uint32 `json:"nv_indexes,omitempty"`
}

// DevID is GET /devid/<serial>: everything public about a machine's LDevID,
// in the shape images/spire-agent-tpm/devid-init reads. The blobs are
// useless outside the TPM that wrapped them.
type DevID struct {
	Machine string `json:"node"`
	Serial  string `json:"serial"`
	// PEM: the leaf then the DevID CA, the form SPIRE's devid_cert_path reads.
	LDevIDCert string `json:"ldevid_cert_pem"`
	LAKCert    string `json:"lak_cert_pem"`
	// PEM: the DevID CA up to the FML root.
	Chain string `json:"chain_pem"`
	// The public blobs are bare TPMT_PUBLIC; the private blobs are
	// TPM2B_PRIVATE without the size prefix: the bytes tpm2.CreateKey
	// returns, and what SPIRE's devid_pub_path and devid_priv_path hold.
	LDevIDPublic  []byte   `json:"ldevid_pub_blob_b64"`
	LDevIDPrivate []byte   `json:"ldevid_priv_blob_b64"`
	AKPublic      []byte   `json:"ak_pub_blob_b64"`
	AKPrivate     []byte   `json:"ak_priv_blob_b64"`
	SRK           string   `json:"srk"`
	EKHashes      []string `json:"ek_hashes"`
	// EKHashesByAlg is the same hashes keyed rsa and ecc.
	EKHashesByAlg map[string]string `json:"ek_hashes_by_alg,omitempty"`
	// RSAEKCert is whether the TPM holds an RSA EK certificate at 0x01c00002,
	// the only EK certificate SPIRE's tpm_devid agent reads.
	RSAEKCert  bool      `json:"rsa_ek_cert"`
	AttestedAt time.Time `json:"attested_at"`
	Confirmed  bool      `json:"confirmed"`
}

// Status is GET /verdict/<serial>, which talos-enroll's auto-approve reads.
// A machine with no verdict, or one waiting for first-intake approval,
// answers 404. NetBox is the source when the service has one: class, site
// and consumed_at mirror its device, and consumed_at is when talos-enroll
// last released a config on the strength of attested_at.
type Status struct {
	Status     string    `json:"status"`
	AttestedAt time.Time `json:"attested_at"`
	Node       string    `json:"node"`
	UUID       string    `json:"uuid,omitempty"`
	RSAEKCert  bool      `json:"rsa_ek_cert"`
	UpdatedAt  time.Time `json:"updated_at"`
	Class      string    `json:"class,omitempty"`
	Site       string    `json:"site,omitempty"`
	ConsumedAt time.Time `json:"consumed_at,omitzero"`
}

// Values of Status.Status.
const (
	StatusAttested    = "attested"
	StatusQuarantined = "quarantined"
)

// SRKECCHighRange names the parent of every key here: the TCG EK credential
// profile's H-2 template (ECC NIST P-256, AES-128-CFB, empty unique) in the
// owner hierarchy. It is what SPIRE's tpm_devid agent creates to load an ECC
// DevID, and the TPM derives the same key from it until the TPM is cleared.
const SRKECCHighRange = "ecc-p256-h2"

// NV indexes for the DER certificates, from 0x01C90000 up. Whether the TCG
// device identity specification reserves exactly these is not checked here.
const (
	NVLDevIDCert uint32 = 0x01c90000
	NVLAKCert    uint32 = 0x01c90001
)
