package fleet

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jonpulsifer/infra/apps/fleetd/classes"
)

const (
	nixosImage   = "https://github.com/jonpulsifer/infra/releases/download/node-images%2F1/nixos-node-amd64.img.zst"
	nixosDigest  = "sha256:ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34"
	debianImage  = "https://cloud.debian.org/images/cloud/trixie/20261001-1/debian-13-genericcloud-amd64-20261001-1.tar.xz"
	debianDigest = "sha256:cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12"
	testSeedURL  = "https://enroll.lolwtf.ca/seed"
)

var testClasses = classes.Table{
	"controlplane": {OS: "talos", Template: "provision", PolicyProfile: "talos"},
	"cp-g5":        {OS: "talos", Template: "provision", PolicyProfile: "talos"},
	"worker-g5":    {OS: "talos", Template: "provision", PolicyProfile: "talos"},
	"worker-g2":    {OS: "talos", Template: "provision", PolicyProfile: "talos"},
	"debian":       {OS: "debian", Workload: "general", Template: "provision-image", PolicyProfile: "debian", PayloadKind: classes.PayloadCloudInit, Image: debianImage, ImageDigest: debianDigest, ImageFormat: "tar.xz"},
	"nixos":        {OS: "nixos", Workload: "general", Template: "provision-image", PolicyProfile: "talos", PayloadKind: classes.PayloadNixOSImage, Image: nixosImage, ImageDigest: nixosDigest, ImageFormat: "raw.zst"},
	"alpine":       {OS: "alpine", Workload: "general", Template: "provision-image", PolicyProfile: "talos", PayloadKind: classes.PayloadAlpineImage},
}

func mustWorkflow(t *testing.T, cfg Config, d Device, action string) Object {
	t.Helper()
	wf, err := cfg.Workflow(d, action, testNow, false)
	if err != nil {
		t.Fatal(err)
	}
	return wf
}

func TestWorkflowFollowsTheClass(t *testing.T) {
	talos := "ghcr.io/jonpulsifer/talos-installer-folly:v1.14.4"
	cfg := Config{Classes: testClasses, Installs: map[string]string{"worker-g5": talos}, ImageInstalls: map[string]bool{"debian": true}, SeedURL: testSeedURL}
	spec := mustWorkflow(t, cfg, Device{Name: "n", Class: "worker-g5", TPM: "2.0", DiskSerial: "30DF7020FGKL"}, "provision")["spec"].(map[string]any)
	hm := spec["hardwareMap"].(map[string]any)
	if spec["templateRef"] != "provision" || hm["installer_image"] != talos || hm["install"] != "true" {
		t.Errorf("worker-g5: template %v, hardwareMap %v", spec["templateRef"], hm)
	}
	if _, ok := hm["image_url"]; ok {
		t.Errorf("a Talos class carries image keys: %v", hm)
	}
	spec = mustWorkflow(t, cfg, Device{Name: "n", Class: "debian", TPM: "2.0", DiskSerial: "30DF7020FGKL"}, "provision")["spec"].(map[string]any)
	hm = spec["hardwareMap"].(map[string]any)
	want := map[string]any{
		"attest": "true", "wipe": "true", "retire": "false", "install": "true", "installer_image": "", "install_disk_serial": "30DF7020FGKL",
		"image_url": debianImage, "image_digest": debianDigest, "image_format": "tar.xz", "payload_kind": classes.PayloadCloudInit, "os": "debian", "seed_url": testSeedURL,
	}
	if spec["templateRef"] != "provision-image" || fmt.Sprint(hm) != fmt.Sprint(want) {
		t.Errorf("debian: template %v, hardwareMap\n got %v\nwant %v", spec["templateRef"], hm, want)
	}
	spec = mustWorkflow(t, cfg, Device{Name: "n", Class: "debian", TPM: "2.0", DiskSerial: "30DF7020FGKL"}, "wipe")["spec"].(map[string]any)
	if hm := spec["hardwareMap"].(map[string]any); spec["templateRef"] != "provision-image" || hm["install"] != "false" || hm["image_url"] != debianImage {
		t.Errorf("a wipe runs %v with %v, not the class's Template with install off", spec["templateRef"], hm)
	}
}

// An image class installs only when the fleet lists it: a class the table
// carries no whole image for, or one left out by the seed URL, runs its
// Template with install false and no image.
func TestImageClassInstallsOnlyWhenListed(t *testing.T) {
	cfg := Config{Classes: testClasses, SeedURL: testSeedURL}
	d := Device{Name: "n", Class: "nixos", TPM: "2.0", DiskSerial: "30DF7020FGKL"}
	if hm := mustWorkflow(t, cfg, d, "provision")["spec"].(map[string]any)["hardwareMap"].(map[string]any); hm["install"] != "false" || hm["image_url"] != nixosImage || hm["installer_image"] != "" {
		t.Errorf("unlisted: %v", hm)
	}
	cfg.ImageInstalls = map[string]bool{"nixos": true}
	if hm := mustWorkflow(t, cfg, d, "provision")["spec"].(map[string]any)["hardwareMap"].(map[string]any); hm["install"] != "true" || hm["payload_kind"] != classes.PayloadNixOSImage || hm["os"] != "nixos" {
		t.Errorf("listed: %v", hm)
	}
	if !cfg.WillInstall(d) || cfg.Installer(d, "provision") != "" {
		t.Errorf("WillInstall %v, Installer %q", cfg.WillInstall(d), cfg.Installer(d, "provision"))
	}
	d.Class, d.TPM = "worker-g2", "1.2"
	if cfg.WillInstall(d) {
		t.Error("a device that attests nothing installs")
	}
	alpine := Device{Name: "n", Class: "alpine", TPM: "2.0", DiskSerial: "30DF7020FGKL"}
	if hm := mustWorkflow(t, cfg, alpine, "provision")["spec"].(map[string]any)["hardwareMap"].(map[string]any); hm["install"] != "false" || hm["image_url"] != "" || hm["seed_url"] != testSeedURL {
		t.Errorf("a class without an image: %v", hm)
	}
}

func TestWorkflowRefusesAnUnknownClass(t *testing.T) {
	cfg := Config{Classes: testClasses}
	for _, class := range []string{"", "worker-g9"} {
		if _, err := cfg.Workflow(Device{Name: "n", Class: class}, "provision", testNow, false); err == nil || !strings.Contains(err.Error(), "class table") {
			t.Errorf("class %q: %v", class, err)
		}
	}
}

// The Hardware's disk carries only the kernel name, so the Workflow carries
// the serial the Template checks, and refuses a run that wipes without one.
func TestWorkflowCarriesTheDiskSerial(t *testing.T) {
	cfg := Config{Classes: testClasses}
	d := Device{Name: "n", Class: "worker-g5", TPM: "2.0", DiskSerial: "30DF7020FGKL"}
	for action := range Actions {
		hm := mustWorkflow(t, cfg, d, action)["spec"].(map[string]any)["hardwareMap"].(map[string]any)
		if hm["install_disk_serial"] != "30DF7020FGKL" {
			t.Errorf("%s: hardwareMap %v", action, hm)
		}
	}
	for _, serial := range []string{"", "30DF 7020", "a'b", "a/b", strings.Repeat("A", 65)} {
		d.DiskSerial = serial
		for action, a := range Actions {
			wf, err := cfg.Workflow(d, action, testNow, false)
			if a.Wipe {
				if err == nil || !strings.Contains(err.Error(), "install_disk_serial") {
					t.Errorf("%s with serial %q: %v", action, serial, err)
				}
				continue
			}
			if err != nil {
				t.Fatalf("%s, which wipes nothing, with serial %q: %v", action, serial, err)
			}
			if hm := wf["spec"].(map[string]any)["hardwareMap"].(map[string]any); hm["install_disk_serial"] != "" {
				t.Errorf("%s carries the malformed serial %q: %v", action, serial, hm)
			}
		}
	}
}

func TestAdmitRefusesAndJournalsAnUnknownClass(t *testing.T) {
	d := declared(map[string]any{"class": "worker-g9"})
	at := newAdmitTest(t, rackMAC, []map[string]any{d}, []map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
	if code, why := at.admit(testCode); code != http.StatusConflict || !strings.Contains(why, `class "worker-g9" is not in the class table`) {
		t.Fatalf("admit: %d %s", code, why)
	}
	if len(at.nb.patches) != 0 || len(at.kube.workflows()) != 0 || !at.journal("not in the class table") {
		t.Errorf("a refused admission wrote: patches %v workflows %v journals %v", at.nb.patches, at.kube.workflows(), at.nb.journals)
	}
}

func TestLoadInstallerTakesAClassImageFromTheTable(t *testing.T) {
	dir := t.TempDir()
	inputs := filepath.Join(dir, "class-inputs.json")
	raw, _ := json.Marshal(riptideInputs())
	_ = os.WriteFile(inputs, raw, 0o600)
	workers := filepath.Join(dir, "worker-secrets")
	_ = os.WriteFile(workers, []byte(fakeBundle("A")), 0o600)
	t.Setenv("FLEET_CLASS_INPUTS", inputs)
	t.Setenv("FLEET_WORKER_SECRETS", workers)
	t.Setenv("FLEET_TALOSCTL", "/bin/false")
	t.Setenv("FLEET_INSTALLS", "true")
	t.Setenv("FLEET_CONTROLPLANE_BUNDLE", "")

	cfg := Config{Classes: pinnedTalosClasses(), SeedURL: testSeedURL}
	if _, err := LoadInstaller(&cfg, nil, nil, NewMetrics()); err != nil {
		t.Fatal(err)
	}
	if cfg.Installs["worker-g5"] != talosImage || cfg.Installs["nixos"] != "" || cfg.Installs["debian"] != "" {
		t.Fatalf("installs %v", cfg.Installs)
	}
	if !cfg.ImageInstalls["nixos"] || !cfg.ImageInstalls["debian"] || cfg.ImageInstalls["alpine"] || cfg.ImageInstalls["worker-g5"] {
		t.Fatalf("image installs %v", cfg.ImageInstalls)
	}
}

// The image classes' installs need no Talos renderer, and need the seed URL.
func TestLoadInstallerListsTheImageClassesWithoutTheTalosRenderer(t *testing.T) {
	for _, k := range []string{"FLEET_CLASS_INPUTS", "FLEET_WORKER_SECRETS", "FLEET_TALOSCTL", "FLEET_CONTROLPLANE_BUNDLE"} {
		t.Setenv(k, "")
	}
	t.Setenv("FLEET_INSTALLS", "true")
	cfg := Config{Classes: testClasses, SeedURL: testSeedURL}
	in, err := LoadInstaller(&cfg, nil, nil, NewMetrics())
	if err != nil || in.Renderer != nil {
		t.Fatalf("%v %+v", err, in)
	}
	if !cfg.ImageInstalls["nixos"] || !cfg.ImageInstalls["debian"] || cfg.ImageInstalls["alpine"] || len(cfg.Installs) != 0 {
		t.Fatalf("image installs %v, installs %v", cfg.ImageInstalls, cfg.Installs)
	}
	cfg = Config{Classes: testClasses}
	if _, err := LoadInstaller(&cfg, nil, nil, NewMetrics()); err != nil || len(cfg.ImageInstalls) != 0 {
		t.Fatalf("without the seed URL: %v %v", err, cfg.ImageInstalls)
	}
	t.Setenv("FLEET_INSTALLS", "false")
	cfg = Config{Classes: testClasses, SeedURL: testSeedURL}
	if _, err := LoadInstaller(&cfg, nil, nil, NewMetrics()); err != nil || cfg.ImageInstalls != nil {
		t.Fatalf("with installs off: %v %v", err, cfg.ImageInstalls)
	}
}

func TestLoadConfigReadsTheSeedURL(t *testing.T) {
	t.Setenv("FLEET_HOOKOS_URL", "http://hookos")
	t.Setenv("FLEET_HOOKOS_CMDLINE", "console=tty0")
	path := filepath.Join(t.TempDir(), "classes.json")
	_ = os.WriteFile(path, []byte(`{"w": {"os": "talos", "workload": "general", "template": "provision", "policy_profile": "talos", "payload_kind": "talos-machineconfig"}}`), 0o600)
	t.Setenv("FLEET_CLASSES", path)
	t.Setenv("FLEET_SEED_URL", "")
	if cfg, err := LoadConfig(); err != nil || cfg.SeedURL != "" {
		t.Fatalf("unset: %v %q", err, cfg.SeedURL)
	}
	t.Setenv("FLEET_SEED_URL", testSeedURL)
	if cfg, err := LoadConfig(); err != nil || cfg.SeedURL != testSeedURL {
		t.Fatalf("set: %v %q", err, cfg.SeedURL)
	}
	for _, bad := range []string{"enroll.lolwtf.ca/seed", "ftp://enroll/seed", "https://enroll.lolwtf.ca/seed?uuid=x"} {
		t.Setenv("FLEET_SEED_URL", bad)
		if _, err := LoadConfig(); err == nil || !strings.Contains(err.Error(), "FLEET_SEED_URL") {
			t.Errorf("%q: %v", bad, err)
		}
	}
}

const talosImage = "ghcr.io/jonpulsifer/talos-installer-folly@sha256:cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34"

// pinnedTalosClasses is testClasses with the Talos classes pinned by digest
// in the table, over the tag the class inputs carry.
func pinnedTalosClasses() classes.Table {
	t := classes.Table{}
	for name, c := range testClasses {
		if c.OS == "talos" {
			c.InstallerImage = talosImage
		}
		t[name] = c
	}
	return t
}

func loadInstallsFrom(t *testing.T, table classes.Table) (Config, error) {
	t.Helper()
	dir := t.TempDir()
	inputs := filepath.Join(dir, "class-inputs.json")
	raw, _ := json.Marshal(riptideInputs())
	_ = os.WriteFile(inputs, raw, 0o600)
	workers := filepath.Join(dir, "worker-secrets")
	_ = os.WriteFile(workers, []byte(fakeBundle("A")), 0o600)
	t.Setenv("FLEET_CLASS_INPUTS", inputs)
	t.Setenv("FLEET_WORKER_SECRETS", workers)
	t.Setenv("FLEET_TALOSCTL", "/bin/false")
	t.Setenv("FLEET_INSTALLS", "true")
	t.Setenv("FLEET_CONTROLPLANE_BUNDLE", "")
	cfg := Config{Classes: table}
	_, err := LoadInstaller(&cfg, nil, nil, NewMetrics())
	return cfg, err
}

func TestInstallerImageMustBePinnedByDigest(t *testing.T) {
	tagged := classes.Table{"worker-g5": {OS: "talos", Template: "provision", PolicyProfile: "talos"}}
	if _, err := loadInstallsFrom(t, tagged); err == nil || !strings.Contains(err.Error(), "worker-g5") || !strings.Contains(err.Error(), "classes.json") {
		t.Fatalf("a class inputs tag with no table pin: %v", err)
	}
	pinned := pinnedTalosClasses()
	cfg, err := loadInstallsFrom(t, pinned)
	if err != nil || cfg.Installs["worker-g5"] != talosImage {
		t.Fatalf("a table digest over the inputs tag: %v %v", err, cfg.Installs)
	}
	if _, err := loadInstallsFrom(t, classes.Table{"worker-g5": {OS: "talos", Template: "provision", PolicyProfile: "talos", InstallerImage: talosImage}}); err != nil {
		t.Fatalf("a table digest alone: %v", err)
	}
}

func TestLoadConfigNeedsTheClassTable(t *testing.T) {
	t.Setenv("FLEET_HOOKOS_URL", "http://hookos")
	t.Setenv("FLEET_HOOKOS_CMDLINE", "console=tty0")
	t.Setenv("FLEET_CLASSES", "")
	if _, err := LoadConfig(); err == nil {
		t.Fatal("a fleet without a class table loaded")
	}
	path := filepath.Join(t.TempDir(), "classes.json")
	_ = os.WriteFile(path, []byte(`{"w": {"os": "talos", "workload": "general", "template": "provision", "policy_profile": "talos", "payload_kind": "talos-machineconfig"}}`), 0o600)
	t.Setenv("FLEET_CLASSES", path)
	cfg, err := LoadConfig()
	if err != nil || cfg.Classes["w"].Template != "provision" {
		t.Fatalf("%v %+v", err, cfg.Classes)
	}
}
