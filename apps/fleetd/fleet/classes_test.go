package fleet

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jonpulsifer/infra/apps/fleetd/classes"
)

const ubuntuImage = "ghcr.io/jonpulsifer/ubuntu-installer@sha256:ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34"

var testClasses = classes.Table{
	"controlplane": {OS: "talos", Template: "provision", PolicyProfile: "talos"},
	"cp-g5":        {OS: "talos", Template: "provision", PolicyProfile: "talos"},
	"worker-g5":    {OS: "talos", Template: "provision", PolicyProfile: "talos"},
	"worker-g2":    {OS: "talos", Template: "provision", PolicyProfile: "talos"},
	"ubuntu":       {OS: "ubuntu", Template: "provision-ubuntu", InstallerImage: ubuntuImage, PolicyProfile: "ubuntu"},
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
	cfg := Config{Classes: testClasses, Installs: map[string]string{"worker-g5": talos, "ubuntu": ubuntuImage}}
	for _, tc := range []struct{ class, template, image string }{
		{"worker-g5", "provision", talos},
		{"ubuntu", "provision-ubuntu", ubuntuImage},
	} {
		spec := mustWorkflow(t, cfg, Device{Name: "n", Class: tc.class, TPM: "2.0", DiskSerial: "30DF7020FGKL"}, "provision")["spec"].(map[string]any)
		hm := spec["hardwareMap"].(map[string]any)
		if spec["templateRef"] != tc.template || hm["installer_image"] != tc.image || hm["install"] != "true" {
			t.Errorf("%s: template %v, hardwareMap %v", tc.class, spec["templateRef"], hm)
		}
	}
	spec := mustWorkflow(t, cfg, Device{Name: "n", Class: "ubuntu", TPM: "2.0", DiskSerial: "30DF7020FGKL"}, "wipe")["spec"].(map[string]any)
	if spec["templateRef"] != "provision-ubuntu" {
		t.Errorf("a wipe runs %v, not the class's Template", spec["templateRef"])
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
	d := declared(map[string]any{"talos_class": "worker-g9"})
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

	cfg := Config{Classes: testClasses}
	if _, err := LoadInstaller(&cfg, nil, nil, NewMetrics()); err != nil {
		t.Fatal(err)
	}
	if cfg.Installs["ubuntu"] != ubuntuImage || cfg.Installs["worker-g5"] == "" || cfg.Installs["worker-g5"] == ubuntuImage {
		t.Fatalf("installs %v", cfg.Installs)
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
	_ = os.WriteFile(path, []byte(`{"w": {"os": "talos", "template": "provision", "policy_profile": "talos", "payload_kind": "talos-machineconfig"}}`), 0o600)
	t.Setenv("FLEET_CLASSES", path)
	cfg, err := LoadConfig()
	if err != nil || cfg.Classes["w"].Template != "provision" {
		t.Fatalf("%v %+v", err, cfg.Classes)
	}
}
