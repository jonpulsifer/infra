package netbox

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// Role is the NetBox device role of a node.
const Role = "kubernetes-node"

// Attested is where fleetd recorded the machine plugged in at its last
// intake pass, from facts the session's AK signed: the switch's LLDP chassis
// ID and port ID, and when.
type Attested struct {
	Switch string
	Port   string
	At     time.Time
}

// Device is what fleetd reads from one NetBox device.
type Device struct {
	ID      int
	Name    string
	Serial  string
	Status  string
	Site    string
	Address string
	MAC     string
	Disk    string
	// DiskSerial is the serial the install disk reports, which the Template
	// checks before it wipes or installs Disk.
	DiskSerial string
	Class      string
	TPM        string
	// EKHash and EKHashECC pin the TPM's endorsement keys; the approved pair
	// is the binding git declares.
	EKHash, EKHashECC                 string
	ApprovedEKHash, ApprovedEKHashECC string
	// AMT and SecureBootExpected are nil while the custom field is empty.
	AMT                *bool
	SecureBootExpected *bool
	BMCType            string
	BMCAddress         string
	OOBAddress         string
	DesiredAction      string
	LastWorkflow       string
	// SMBIOSUUID is the machine's attested SMBIOS UUID, lower-cased.
	SMBIOSUUID string
	// Model is the device type's model.
	Model       string
	Verdict     string
	Description string
	// ExpectedPort is the switch port a stub expects its machine on, 0 for
	// any.
	ExpectedPort int
	// Attested is the network facts of the last intake pass.
	Attested Attested

	LastUpdated  time.Time
	LastAttested string
	ConsumedAt   string
	LDevIDSerial string
	LAKSerial    string
	SKU          string
	BIOSVersion  string

	// Fields holds every custom field as NetBox sent it. Field is nil for
	// one NetBox does not define.
	Fields map[string]json.RawMessage
}

// Field is a custom field's raw value, nil when NetBox defines none.
func (d Device) Field(name string) json.RawMessage { return d.Fields[name] }

// Installing says whether a planned device has passed attestation: its
// first install, or a reinstall after a provision or wipe moved it back to
// planned. It stays planned until its node fetches its config.
func (d Device) Installing() bool { return d.Status == "planned" && PassedVerdict(d.Verdict) }

// PassedVerdict says whether an attest_verdict is a pass, as the verifier
// reads it: attested, or a control plane's failed check that left it in
// place.
func PassedVerdict(verdict string) bool {
	return verdict == "attested" || strings.HasPrefix(verdict, "failed-no-quarantine")
}

// HasBMC says whether the device gets a Machine now: a BMC type and an
// address for it, which for AMT is the device's own declared address, from
// the moment it has one, a planned device's included.
func (d Device) HasBMC() bool {
	return d.BMCType != "" && d.BMCType != "none" && d.BMCAddress != ""
}

// ManualBoot says whether Rufio stays out of a run: a device without a
// Machine.
func (d Device) ManualBoot() bool { return !d.HasBMC() }

// SelectValue reads a NetBox value that is a plain string in one API shape and
// a {value, label} object in another: status fields, and select custom fields
// in a webhook payload.
func SelectValue(raw json.RawMessage) string {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	var o struct {
		Value string `json:"value"`
	}
	if err := json.Unmarshal(raw, &o); err == nil {
		return o.Value
	}
	return ""
}

type rawDevice struct {
	ID          int             `json:"id"`
	Name        string          `json:"name"`
	Serial      string          `json:"serial"`
	Status      json.RawMessage `json:"status"`
	Description string          `json:"description"`
	Site        *struct {
		Slug string `json:"slug"`
	} `json:"site"`
	LastUpdated string `json:"last_updated"`
	DeviceType  *struct {
		Model string `json:"model"`
	} `json:"device_type"`
	PrimaryIP4 *struct {
		Address string `json:"address"`
	} `json:"primary_ip4"`
	OOBIP *struct {
		Address string `json:"address"`
	} `json:"oob_ip"`
	CustomFields map[string]json.RawMessage `json:"custom_fields"`
}

func boolValue(raw json.RawMessage) *bool {
	var b *bool
	if json.Unmarshal(raw, &b) != nil {
		return nil
	}
	return b
}

func intValue(raw json.RawMessage) int {
	var n *int
	if json.Unmarshal(raw, &n) != nil || n == nil {
		return 0
	}
	return *n
}

func stripPrefix(cidr string) string {
	addr, _, _ := strings.Cut(cidr, "/")
	return addr
}

// ParseDevice decodes one dcim.device.
func ParseDevice(raw json.RawMessage) (Device, error) {
	var r rawDevice
	if err := json.Unmarshal(raw, &r); err != nil {
		return Device{}, err
	}
	cf := func(k string) string { return SelectValue(r.CustomFields[k]) }
	d := Device{
		ID:                 r.ID,
		Name:               r.Name,
		Serial:             r.Serial,
		Status:             SelectValue(r.Status),
		Disk:               cf("install_disk"),
		DiskSerial:         cf("install_disk_serial"),
		Class:              cf("class"),
		TPM:                cf("tpm_version"),
		EKHash:             cf("ek_hash"),
		EKHashECC:          cf("ek_hash_ecc"),
		ApprovedEKHash:     cf("approved_ek_hash"),
		ApprovedEKHashECC:  cf("approved_ek_hash_ecc"),
		BMCType:            cf("bmc_type"),
		DesiredAction:      cf("desired_action"),
		LastWorkflow:       cf("last_workflow"),
		SMBIOSUUID:         strings.ToLower(cf("smbios_uuid")),
		Verdict:            cf("attest_verdict"),
		LastAttested:       cf("last_attested"),
		ConsumedAt:         cf("attest_consumed_at"),
		LDevIDSerial:       cf("ldevid_serial"),
		LAKSerial:          cf("lak_serial"),
		SKU:                cf("sku"),
		BIOSVersion:        cf("bios_version"),
		Description:        r.Description,
		ExpectedPort:       intValue(r.CustomFields["expected_port"]),
		AMT:                boolValue(r.CustomFields["amt"]),
		SecureBootExpected: boolValue(r.CustomFields["secure_boot_expected"]),
		Fields:             r.CustomFields,
	}
	d.LastUpdated, _ = time.Parse(time.RFC3339Nano, r.LastUpdated)
	if r.Site != nil {
		d.Site = r.Site.Slug
	}
	if r.DeviceType != nil {
		d.Model = r.DeviceType.Model
	}
	d.Attested = Attested{Switch: strings.ToLower(cf("attested_switch")), Port: cf("attested_switch_port")}
	d.Attested.At, _ = time.Parse(time.RFC3339, cf("attested_network_at"))
	if d.DesiredAction == "" {
		d.DesiredAction = "none"
	}
	if r.PrimaryIP4 != nil {
		d.Address = stripPrefix(r.PrimaryIP4.Address)
	}
	if r.OOBIP != nil {
		d.OOBAddress = stripPrefix(r.OOBIP.Address)
	}
	// oob_ip, or the node's own declared address for AMT, which shares the
	// node's NIC and address.
	switch {
	case d.BMCType == "" || d.BMCType == "none":
	case r.OOBIP != nil && r.OOBIP.Address != "":
		d.BMCAddress = stripPrefix(r.OOBIP.Address)
	case d.BMCType == "amt":
		d.BMCAddress = d.Address
	}
	return d, nil
}

// Plain strips what NetBox's journal would render as Markdown, and control
// characters, from text a machine or a switch supplied.
func Plain(s string) string {
	return strings.TrimSpace(strings.Map(func(r rune) rune {
		if r < ' ' || r == 0x7f || strings.ContainsRune("*_`#[]()<>|~\\", r) {
			return ' '
		}
		return r
	}, s))
}

// strictStrings are the custom fields the attestation service trusts: each
// must be a JSON string or null.
var strictStrings = []string{"ek_hash", "ek_hash_ecc", "approved_ek_hash", "approved_ek_hash_ecc", "attest_verdict", "last_attested", "attest_consumed_at", "ldevid_serial", "lak_serial", "sku", "bios_version"}

// ParseDeviceStrict is ParseDevice for a reader that fails closed. A security
// field that is present and neither null nor a string, a status that is
// neither null nor an object, and a last_updated that does not parse are
// errors, so a malformed record never reads as an empty one.
func ParseDeviceStrict(raw json.RawMessage) (Device, error) {
	d, err := ParseDevice(raw)
	if err != nil {
		return Device{}, err
	}
	for _, k := range strictStrings {
		if err := json.Unmarshal(orNull(d.Fields[k]), new(*string)); err != nil {
			return Device{}, fmt.Errorf("custom field %s: %w", k, err)
		}
	}
	var r struct {
		Status      *struct{}  `json:"status"`
		LastUpdated *time.Time `json:"last_updated"`
	}
	if err := json.Unmarshal(raw, &r); err != nil {
		return Device{}, err
	}
	return d, nil
}

func orNull(raw json.RawMessage) json.RawMessage {
	if raw == nil {
		return json.RawMessage("null")
	}
	return raw
}
