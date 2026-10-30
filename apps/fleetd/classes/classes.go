// Package classes reads the class table, which says what each class of
// machine runs: the Template and installer image fleetd gives its Workflow,
// and the attestation profile the verifier holds its boot to. Git owns the
// table, and fleetd reads it from the file the host deploys with it.
package classes

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
)

const (
	PayloadTalosConfig = "talos-machineconfig"
	PayloadCloudInit   = "cloud-init-nocloud"
)

// Class is one entry of the table.
type Class struct {
	// Description says what the class trusts, for the next reader of the file.
	Description string `json:"description"`
	OS          string `json:"os"`
	// Template names the Tinkerbell Template every Workflow of the class runs.
	Template string `json:"template"`
	// InstallerImage is the image the install action runs, pinned by digest.
	// A Talos class leaves it empty: its image comes from the class inputs.
	InstallerImage string `json:"installer_image"`
	// PolicyProfile names the attestation profile, a file under the policy
	// directory.
	PolicyProfile string `json:"policy_profile"`
	// SecureBoot is whether the class boots with Secure Boot on. Its profile
	// must agree.
	SecureBoot  bool   `json:"secure_boot"`
	PayloadKind string `json:"payload_kind"`
	// Reattest is whether the running node renews its identity and runs the
	// daily check.
	Reattest bool `json:"reattest"`
}

// Table maps a class name, NetBox's class field, to its record.
type Table map[string]Class

var digestRE = regexp.MustCompile(`@sha256:[0-9a-f]{64}$`)

// Load reads and checks a class table.
func Load(path string) (Table, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var t Table
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&t); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if len(t) == 0 {
		return nil, fmt.Errorf("%s: no classes", path)
	}
	for name, c := range t {
		if err := c.validate(); err != nil {
			return nil, fmt.Errorf("%s: class %s: %w", path, name, err)
		}
	}
	return t, nil
}

func (c Class) validate() error {
	switch c.OS {
	case "talos", "ubuntu":
	default:
		return fmt.Errorf("os %q is neither talos nor ubuntu", c.OS)
	}
	switch c.PayloadKind {
	case PayloadTalosConfig, PayloadCloudInit:
	default:
		return fmt.Errorf("payload_kind %q is unknown", c.PayloadKind)
	}
	if c.Template == "" || c.PolicyProfile == "" {
		return fmt.Errorf("template and policy_profile are required")
	}
	if c.InstallerImage != "" && !digestRE.MatchString(c.InstallerImage) {
		return fmt.Errorf("installer_image %q is not pinned by digest", c.InstallerImage)
	}
	return nil
}
