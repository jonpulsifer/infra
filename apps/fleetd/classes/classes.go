// Package classes reads the class table, which says what each class of
// machine runs: the Template and installer image fleetd gives its Workflow,
// and the attestation profile the verifier holds its boot to. Git owns the
// table, and fleetd reads it from the file the host deploys with it.
package classes

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"regexp"
)

const (
	PayloadTalosConfig = "talos-machineconfig"
	PayloadCloudInit   = "cloud-init-nocloud"
	PayloadNixOSImage  = "nixos-image"
	PayloadAlpineImage = "alpine-image"
)

// Class is one entry of the table.
type Class struct {
	// Description says what the class trusts, for the next reader of the file.
	Description string `json:"description"`
	OS          string `json:"os"`
	// Workload is what the machine is for; general today.
	Workload string `json:"workload"`
	// Template names the Tinkerbell Template every Workflow of the class runs.
	Template string `json:"template"`
	// InstallerImage is the image the install action runs, pinned by digest.
	// A Talos class leaves it empty: its image comes from the class inputs.
	// An image class leaves it empty too: it installs Image.
	InstallerImage string `json:"installer_image"`
	// Image is the disk image an image class writes to the install disk,
	// with the sha256 of the downloaded file and its format: all three or
	// none, and the class installs only with all three.
	Image       string `json:"image,omitempty"`
	ImageDigest string `json:"image_digest,omitempty"`
	ImageFormat string `json:"image_format,omitempty"`
	// PolicyProfile names the attestation profile, a file under the policy
	// directory.
	PolicyProfile string `json:"policy_profile"`
	// SecureBoot is whether the class boots with Secure Boot on. Its profile
	// must agree.
	SecureBoot  bool   `json:"secure_boot"`
	PayloadKind string `json:"payload_kind"`
	// Reattest is whether the running node renews its identity and runs the
	// hourly check.
	Reattest bool `json:"reattest"`
}

// Table maps a class name, NetBox's class field, to its record.
type Table map[string]Class

var workloadRE = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)

var digestRE = regexp.MustCompile(`@sha256:[0-9a-f]{64}$`)

var fileDigestRE = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

// ImageFormats are the ways a class's Image is packed: a raw disk, one
// compressed with zstd or gzip, or a tarball whose first member is the raw
// disk, as Debian's generic cloud image is.
var ImageFormats = []string{"raw", "raw.zst", "raw.gz", "tar.xz"}

// PinnedByDigest says whether an image reference ends in a sha256 digest.
func PinnedByDigest(image string) bool { return digestRE.MatchString(image) }

// ImagePayload says whether a payload kind installs a disk image, which the
// provision-image Template writes and seeds, rather than a Talos installer.
func ImagePayload(kind string) bool {
	switch kind {
	case PayloadCloudInit, PayloadNixOSImage, PayloadAlpineImage:
		return true
	}
	return false
}

// Installs says whether the class carries a complete image: its payload is
// an image and image, image_digest and image_format are all set. A Talos
// class installs through the class inputs, not through this.
func (c Class) Installs() bool {
	return ImagePayload(c.PayloadKind) && c.Image != "" && c.ImageDigest != "" && c.ImageFormat != ""
}

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
	case "talos", "nixos", "alpine", "debian", "ubuntu":
	default:
		return fmt.Errorf("os %q is not talos, nixos, alpine, debian or ubuntu", c.OS)
	}
	if !workloadRE.MatchString(c.Workload) {
		return fmt.Errorf("workload %q is required and must match %s", c.Workload, workloadRE)
	}
	switch c.PayloadKind {
	case PayloadTalosConfig, PayloadCloudInit, PayloadNixOSImage, PayloadAlpineImage:
	default:
		return fmt.Errorf("payload_kind %q is unknown", c.PayloadKind)
	}
	if c.Template == "" || c.PolicyProfile == "" {
		return fmt.Errorf("template and policy_profile are required")
	}
	if c.InstallerImage != "" && !digestRE.MatchString(c.InstallerImage) {
		return fmt.Errorf("installer_image %q is not pinned by digest", c.InstallerImage)
	}
	return c.validateImage()
}

// validateImage checks the image fields: all three or none, on an image
// class alone, which carries no installer_image.
func (c Class) validateImage() error {
	set := 0
	for _, f := range []string{c.Image, c.ImageDigest, c.ImageFormat} {
		if f != "" {
			set++
		}
	}
	if set == 0 {
		return nil
	}
	if set != 3 {
		return fmt.Errorf("image, image_digest and image_format go together")
	}
	if !ImagePayload(c.PayloadKind) {
		return fmt.Errorf("image is for a %s, %s or %s class, not a %s one", PayloadNixOSImage, PayloadAlpineImage, PayloadCloudInit, c.PayloadKind)
	}
	if c.InstallerImage != "" {
		return fmt.Errorf("an image class installs its image, not an installer_image")
	}
	if u, err := url.Parse(c.Image); err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return fmt.Errorf("image %q is not an http(s) URL", c.Image)
	}
	if !fileDigestRE.MatchString(c.ImageDigest) {
		return fmt.Errorf("image_digest %q is not sha256: and 64 hex digits", c.ImageDigest)
	}
	known := false
	for _, f := range ImageFormats {
		known = known || f == c.ImageFormat
	}
	if !known {
		return fmt.Errorf("image_format %q is not one of %v", c.ImageFormat, ImageFormats)
	}
	return nil
}
