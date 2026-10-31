package fleet

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"text/template"
	"time"

	"gopkg.in/yaml.v3"
)

const templatePath = "../../../clusters/folly/tinkerbell/template.yaml"

type tinkAction struct {
	Name       string   `yaml:"name"`
	Image      string   `yaml:"image"`
	Volumes    []string `yaml:"volumes"`
	Command    []string `yaml:"command"`
	Namespaces struct {
		Network string `yaml:"network"`
	} `yaml:"namespaces"`
}

type tinkWorkflow struct {
	GlobalTimeout int `yaml:"global_timeout"`
	Tasks         []struct {
		Volumes     []string          `yaml:"volumes"`
		Environment map[string]string `yaml:"environment"`
		Actions     []tinkAction      `yaml:"actions"`
	} `yaml:"tasks"`
}

// renderTemplate renders the provision Template as Tinkerbell's workflow
// controller does: Go templates over the Hardware and the hardwareMap, with
// missingkey=error.
func renderTemplate(t *testing.T, hardwareMap map[string]any) tinkWorkflow {
	t.Helper()
	raw, err := os.ReadFile(templatePath)
	if err != nil {
		t.Skip("the provision Template is not beside this checkout")
	}
	var obj struct {
		Spec struct {
			Data string `yaml:"data"`
		} `yaml:"spec"`
	}
	if err := yaml.Unmarshal(raw, &obj); err != nil || obj.Spec.Data == "" {
		t.Fatalf("the Template: %v", err)
	}
	tpl, err := template.New("provision").Option("missingkey=error").Parse(obj.Spec.Data)
	if err != nil {
		t.Fatal(err)
	}
	data := map[string]any{"Hardware": map[string]any{
		"Disks":      []string{"/dev/nvme0n1"},
		"Interfaces": []any{map[string]any{"DHCP": map[string]any{"MAC": "38:22:e2:2d:96:44"}}},
	}}
	for k, v := range hardwareMap {
		data[k] = v
	}
	var out bytes.Buffer
	if err := tpl.Execute(&out, data); err != nil {
		t.Fatalf("render: %v", err)
	}
	var wf tinkWorkflow
	if err := yaml.Unmarshal(out.Bytes(), &wf); err != nil || len(wf.Tasks) != 1 {
		t.Fatalf("the rendered workflow: %v\n%s", err, out.String())
	}
	return wf
}

func provisionMap(t *testing.T) map[string]any {
	cfg := Config{Classes: testClasses,
		Installs: map[string]string{"worker-g5": "ghcr.io/jonpulsifer/talos-installer-folly:v1.14.4"}}
	d := Device{Name: "riptide", Class: "worker-g5", TPM: "2.0", Status: "planned", Verdict: "attested", BMCType: "amt", BMCAddress: "10.3.0.12"}
	return mustWorkflow(t, cfg, d, "provision")["spec"].(map[string]any)["hardwareMap"].(map[string]any)
}

func TestTemplateRendersTheInstall(t *testing.T) {
	wf := renderTemplate(t, provisionMap(t))
	task := wf.Tasks[0]
	var names []string
	actions := map[string]tinkAction{}
	for _, a := range task.Actions {
		names = append(names, a.Name)
		actions[a.Name] = a
	}
	if got := strings.Join(names, ","); got != "wipe-disk,install,next-boot,reboot" {
		t.Fatalf("actions %s", got)
	}
	env := task.Environment
	if env["INSTALL"] != "true" || env["INSTALLER_IMAGE"] != "ghcr.io/jonpulsifer/talos-installer-folly:v1.14.4" || env["DISK"] != "/dev/nvme0n1" {
		t.Fatalf("environment %v", env)
	}
	// The agent's entrypoint attests at boot and writes the install code
	// under HookOS's /worker, which the install action mounts.
	for _, name := range []string{"wipe-disk", "install"} {
		if !contains(actions[name].Volumes, "/worker/fleet:/tmp/fleet") {
			t.Errorf("%s does not mount /worker/fleet: %v", name, actions[name].Volumes)
		}
	}
	if env["ATTEST"] != "true" {
		t.Errorf("a provision's wipe waits for no attestation: %v", env)
	}
	for name, a := range actions {
		if a.Namespaces.Network != "" {
			t.Errorf("%s runs in network namespace %q", name, a.Namespaces.Network)
		}
	}
}

func TestTemplateRendersAWorkflowWithoutInstallKeys(t *testing.T) {
	old := provisionMap(t)
	delete(old, "install")
	delete(old, "installer_image")
	delete(old, "attest")
	env := renderTemplate(t, old).Tasks[0].Environment
	// A Workflow without the attest key fails closed: it attests.
	if env["INSTALL"] != "false" || env["INSTALLER_IMAGE"] != "" || env["ATTEST"] != "true" {
		t.Fatalf("a Workflow without install keys: %v", env)
	}
}

// fleetd ends a Workflow that has no deadline by the Template's global
// timeout when the Workflow's status carries none.
func TestTemplateGlobalTimeoutIsFleetdsFallback(t *testing.T) {
	got := time.Duration(renderTemplate(t, provisionMap(t)).GlobalTimeout) * time.Second
	if got != TemplateGlobalTimeout {
		t.Fatalf("the Template's global_timeout is %s, TemplateGlobalTimeout %s", got, TemplateGlobalTimeout)
	}
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// TestInstallActionScript runs the install action's shell with a docker
// that records its arguments. The script's /tmp/fleet and console devices are
// pointed into a temp dir, so the test needs no hardware paths.
func TestInstallActionScript(t *testing.T) {
	wf := renderTemplate(t, provisionMap(t))
	var script string
	for _, a := range wf.Tasks[0].Actions {
		if a.Name == "install" {
			if len(a.Command) != 3 || a.Command[0] != "/bin/sh" || a.Command[1] != "-c" {
				t.Fatalf("command %v", a.Command)
			}
			script = a.Command[2]
		}
	}
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("no sh")
	}
	dir := t.TempDir()
	fleetDir := filepath.Join(dir, "fleet")
	if err := os.Mkdir(fleetDir, 0o755); err != nil {
		t.Fatal(err)
	}
	script = strings.ReplaceAll(script, "/tmp/fleet", fleetDir)
	script = strings.ReplaceAll(script, "/dev/tty0 /dev/ttyS0", filepath.Join(dir, "console"))
	argsFile := filepath.Join(dir, "args")
	os.WriteFile(filepath.Join(dir, "docker"), []byte("#!/bin/sh\nprintf '%s\\n' \"$@\" > "+argsFile+"\n"), 0o755)
	codeFile := filepath.Join(dir, "install_code")

	run := func(install, code string) (string, error) {
		os.Remove(argsFile)
		os.Remove(codeFile)
		if code != "" {
			os.WriteFile(codeFile, []byte(code), 0o600)
		}
		cmd := exec.Command(sh, "-c", script)
		cmd.Env = []string{"PATH=" + dir + ":" + os.Getenv("PATH")}
		for k, v := range wf.Tasks[0].Environment {
			cmd.Env = append(cmd.Env, k+"="+v)
		}
		cmd.Env = append(cmd.Env, "INSTALL="+install, "INSTALL_CODE_FILE="+codeFile)
		out, err := cmd.CombinedOutput()
		args, _ := os.ReadFile(argsFile)
		if err != nil {
			return string(out), err
		}
		return string(args), nil
	}

	args, err := run("true", testCode)
	if err != nil {
		t.Fatalf("install: %v %s", err, args)
	}
	want := "--entrypoint\n/bin/installer\nghcr.io/jonpulsifer/talos-installer-folly:v1.14.4\ninstall\n--platform\nmetal\n--disk\n/dev/nvme0n1\n--meta\n0x0b=" + testCode + "\n"
	if !strings.HasSuffix(args, want) || !strings.Contains(args, "type=efivarfs") {
		t.Fatalf("docker ran with:\n%s", args)
	}
	for _, bad := range []string{"", "short", strings.Repeat("A", 42) + "$", strings.Repeat("A", 44)} {
		if out, err := run("true", bad); err == nil {
			t.Errorf("code %q installed: %s", bad, out)
		}
	}
	if args, err := run("false", testCode); err != nil || args != "" {
		t.Fatalf("a run without install: %v %q", err, args)
	}
}

// TestWipeWaitsForTheBootsPass runs the wipe action's shell: a run that
// attests wipes nothing until the boot passed, and a run that installs
// nothing without the install code. A disk that is no block device stops
// the script just after the gates, so the test needs no disk.
func TestWipeWaitsForTheBootsPass(t *testing.T) {
	wf := renderTemplate(t, provisionMap(t))
	var script string
	for _, a := range wf.Tasks[0].Actions {
		if a.Name == "wipe-disk" {
			script = a.Command[2]
		}
	}
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("no sh")
	}
	dir := t.TempDir()
	script = strings.ReplaceAll(script, "/dev/tty0 /dev/ttyS0", filepath.Join(dir, "console"))
	attested, code := filepath.Join(dir, "attested"), filepath.Join(dir, "install_code")
	bin := filepath.Join(dir, "bin")
	if err := os.Mkdir(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	// A docker whose daemon holds no containers, or one installer it cannot remove.
	stub := "#!/bin/sh\nif [ \"$1\" = ps ] && [ -e \"" + dir + "/stuck\" ]; then echo abc123; fi\nexit 0\n"
	if err := os.WriteFile(filepath.Join(bin, "docker"), []byte(stub), 0o755); err != nil {
		t.Fatal(err)
	}
	run := func(attest, wipe, install string, files ...string) string {
		os.Remove(attested)
		os.Remove(code)
		for _, f := range files {
			os.WriteFile(f, []byte(testCode), 0o600)
		}
		cmd := exec.Command(sh, "-c", script)
		cmd.Env = []string{"PATH=" + bin + ":" + os.Getenv("PATH")}
		for k, v := range wf.Tasks[0].Environment {
			cmd.Env = append(cmd.Env, k+"="+v)
		}
		cmd.Env = append(cmd.Env, "ATTEST="+attest, "WIPE="+wipe, "INSTALL="+install, "ATTESTED_FILE="+attested, "INSTALL_CODE_FILE="+code, "DISK="+filepath.Join(dir, "disk"))
		out, _ := cmd.CombinedOutput()
		return string(out)
	}
	for _, c := range []struct {
		attest, wipe, install string
		files                 []string
		want                  string
	}{
		{"true", "true", "true", nil, "did not pass attestation"},
		{"true", "true", "true", []string{code}, "did not pass attestation"},
		{"true", "true", "true", []string{attested}, "no install code"},
		{"true", "true", "true", []string{attested, code}, "is not a block device"},
		{"true", "true", "false", []string{attested}, "is not a block device"},
		{"false", "true", "false", nil, "is not a block device"},
		// An attest run fails when the boot's attestation did.
		{"true", "false", "false", nil, "did not pass attestation"},
		{"true", "false", "false", []string{attested}, "nothing wiped this run"},
		{"false", "false", "false", nil, "nothing wiped this run"},
	} {
		if out := run(c.attest, c.wipe, c.install, c.files...); !strings.Contains(out, c.want) {
			t.Errorf("attest %s wipe %s install %s with %v: %q, want %q", c.attest, c.wipe, c.install, c.files, out, c.want)
		}
	}
	// An installer that survives its removal stops the wipe.
	if err := os.WriteFile(filepath.Join(dir, "stuck"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if out := run("false", "true", "false"); !strings.Contains(out, "installer from an earlier run is still there") {
		t.Errorf("a leftover installer did not stop the wipe: %q", out)
	}
}
