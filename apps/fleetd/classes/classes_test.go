package classes

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func load(t *testing.T, body string) error {
	t.Helper()
	path := filepath.Join(t.TempDir(), "classes.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := Load(path)
	return err
}

func TestLoadRequiresAWellFormedWorkload(t *testing.T) {
	const entry = `{"c": {"os": "nixos", %s"template": "t", "policy_profile": "p", "payload_kind": "nixos-image"}}`
	if err := load(t, strings.Replace(entry, "%s", `"workload": "general", `, 1)); err != nil {
		t.Fatalf("a valid class: %v", err)
	}
	for name, field := range map[string]string{
		"missing":   "",
		"empty":     `"workload": "", `,
		"uppercase": `"workload": "General", `,
		"digit":     `"workload": "1x", `,
		"space":     `"workload": "a b", `,
	} {
		if err := load(t, strings.Replace(entry, "%s", field, 1)); err == nil || !strings.Contains(err.Error(), "workload") {
			t.Errorf("%s workload: %v", name, err)
		}
	}
}

const (
	testImage       = "https://github.com/jonpulsifer/infra/releases/download/node-images%2F1/nixos-node-amd64.img.zst"
	testImageDigest = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
)

func TestLoadChecksTheImageFields(t *testing.T) {
	entry := func(fields string) string {
		return `{"c": {"os": "nixos", "workload": "general", "template": "provision-image", "policy_profile": "talos", "payload_kind": "nixos-image"` + fields + `}}`
	}
	all := `, "image": "` + testImage + `", "image_digest": "` + testImageDigest + `", "image_format": "raw.zst"`
	if err := load(t, entry(all)); err != nil {
		t.Fatalf("a complete image: %v", err)
	}
	if err := load(t, entry("")); err != nil {
		t.Fatalf("no image: %v", err)
	}
	for name, tc := range map[string]struct{ fields, want string }{
		"url alone":               {`, "image": "` + testImage + `"`, "go together"},
		"no format":               {`, "image": "` + testImage + `", "image_digest": "` + testImageDigest + `"`, "go together"},
		"a bare path":             {`, "image": "/srv/x.img", "image_digest": "` + testImageDigest + `", "image_format": "raw"`, "http(s) URL"},
		"a digest without sha256": {`, "image": "` + testImage + `", "image_digest": "` + testImageDigest[7:] + `", "image_format": "raw"`, "image_digest"},
		"a short digest":          {`, "image": "` + testImage + `", "image_digest": "sha256:abc", "image_format": "raw"`, "image_digest"},
		"an unknown format":       {`, "image": "` + testImage + `", "image_digest": "` + testImageDigest + `", "image_format": "qcow2"`, "image_format"},
		"with an installer":       {all + `, "installer_image": "ghcr.io/x/y@` + testImageDigest + `"`, "installer_image"},
	} {
		if err := load(t, entry(tc.fields)); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: %v", name, err)
		}
	}
	// A Talos class carries its metal image beside its installer.
	talos := `{"c": {"os": "talos", "workload": "general", "template": "provision", "policy_profile": "talos", "payload_kind": "talos-machineconfig", "installer_image": "ghcr.io/x/y@` + testImageDigest + `"` + all + `}}`
	if err := load(t, talos); err != nil {
		t.Errorf("a Talos class with an image: %v", err)
	}
	if err := load(t, strings.Replace(talos, `"image_format": "raw.zst"`, `"image_format": ""`, 1)); err == nil || !strings.Contains(err.Error(), "go together") {
		t.Errorf("a Talos class with half an image: %v", err)
	}
}

func TestInstallsNeedsTheWholeImage(t *testing.T) {
	c := Class{OS: "debian", Workload: "general", Template: "provision-image", PolicyProfile: "debian", PayloadKind: PayloadCloudInit}
	if c.Installs() {
		t.Error("a class without an image installs")
	}
	c.Image, c.ImageDigest, c.ImageFormat = testImage, testImageDigest, "tar.xz"
	if !c.Installs() {
		t.Error("a complete image class installs nothing")
	}
	c.PayloadKind = PayloadTalosConfig
	if c.Installs() {
		t.Error("a Talos class installs through the image fields")
	}
	if !c.TalosImage() {
		t.Error("a Talos class with a complete image has no Talos image")
	}
	c.ImageFormat = ""
	if c.TalosImage() {
		t.Error("a Talos class with half an image has a Talos image")
	}
}

func TestLoadAcceptsEachOS(t *testing.T) {
	for _, os := range []string{"talos", "nixos", "alpine", "debian", "ubuntu"} {
		body := `{"c": {"os": "` + os + `", "workload": "general", "template": "t", "policy_profile": "p", "payload_kind": "cloud-init-nocloud"}}`
		if err := load(t, body); err != nil {
			t.Errorf("%s: %v", os, err)
		}
	}
	if err := load(t, `{"c": {"os": "windows", "workload": "general", "template": "t", "policy_profile": "p", "payload_kind": "cloud-init-nocloud"}}`); err == nil || !strings.Contains(err.Error(), "os") {
		t.Errorf("windows: %v", err)
	}
}
