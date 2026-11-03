package protocol

import (
	"crypto/sha256"
	"encoding/json"
)

// The routes fleet-boot reaches after its confirm, under the device flow's
// base URL, over the session that passed. fleetd answers 404 to a session
// it holds no run for, and a fleetd without the boot executor serves
// neither route.
const (
	PathBootRun    = "/v1/boot/{session}/run"
	PathBootReport = "/v1/boot/{session}/report"
)

// BootLabel follows the session's nonce in what the AK signs over a boot
// request.
const BootLabel = "boot"

// The steps of a run, in the order fleet-boot takes them.
const (
	StepWipe     = "wipe"
	StepInstall  = "install"
	StepNextBoot = "next-boot"
	StepReboot   = "reboot"
)

// The phases a step report names.
const (
	PhaseStarted   = "started"
	PhaseSucceeded = "succeeded"
	PhaseFailed    = "failed"
)

// BootRequest is one request over a passed session. Seq orders the
// session's requests: fleetd refuses one whose Seq is not above the last it
// took, so a captured request cannot be sent again. Signature is the
// session's AK signing BootDigest of the route, Seq and Report, a
// TPMT_SIGNATURE. The run request carries no Report.
type BootRequest struct {
	Seq       uint64      `json:"seq"`
	Report    *BootReport `json:"report,omitempty"`
	Signature []byte      `json:"signature"`
}

// BootReport says where a run is: the step, and whether it started,
// succeeded or failed, with the reason.
type BootReport struct {
	Run    string `json:"run"`
	Step   string `json:"step"`
	Phase  string `json:"phase"`
	Detail string `json:"detail,omitempty"`
}

// BootRun is fleetd's answer to the run request: the inputs the Template's
// hardwareMap carries for a Workflow, by the same names. A Run of "" says
// the boot has nothing to do.
type BootRun struct {
	Run    string `json:"run"`
	Action string `json:"action,omitempty"`
	Attest bool   `json:"attest"`
	Wipe   bool   `json:"wipe"`
	Retire bool   `json:"retire"`
	// Install says whether the run writes the disk: Talos, by
	// InstallerImage or, as an image, by Image; or an image class's Image.
	Install bool `json:"install"`
	// Disk is the kernel name the nodes file declares, and DiskSerial the
	// serial that disk must report.
	Disk           string `json:"disk,omitempty"`
	DiskSerial     string `json:"install_disk_serial,omitempty"`
	InstallerImage string `json:"installer_image,omitempty"`
	ImageURL       string `json:"image_url,omitempty"`
	ImageDigest    string `json:"image_digest,omitempty"`
	ImageFormat    string `json:"image_format,omitempty"`
	PayloadKind    string `json:"payload_kind,omitempty"`
	OS             string `json:"os,omitempty"`
	SeedURL        string `json:"seed_url,omitempty"`
}

// BootData is what the AK signs over: the session's nonce, BootLabel and
// SHA-256 of the route, the sequence number and the report. It stays short
// enough for TPM2_Hash.
func BootData(nonce []byte, route string, seq uint64, report *BootReport) []byte {
	b, _ := json.Marshal(struct {
		Route  string      `json:"route"`
		Seq    uint64      `json:"seq"`
		Report *BootReport `json:"report,omitempty"`
	}{route, seq, report})
	sum := sha256.Sum256(b)
	return append(append(append([]byte{}, nonce...), BootLabel...), sum[:]...)
}

// BootDigest is SHA-256 over BootData.
func BootDigest(nonce []byte, route string, seq uint64, report *BootReport) []byte {
	sum := sha256.Sum256(BootData(nonce, route, seq, report))
	return sum[:]
}
