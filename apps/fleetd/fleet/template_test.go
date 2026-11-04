package fleet

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
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
	d := Device{Name: "riptide", Class: "worker-g5", TPM: "2.0", Status: "planned", Verdict: "attested", BMCType: "amt", BMCAddress: "10.3.0.12", DiskSerial: "30DF7020FGKL"}
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
	if env["INSTALL"] != "true" || env["INSTALLER_IMAGE"] != "ghcr.io/jonpulsifer/talos-installer-folly:v1.14.4" || env["DISK"] != "/dev/nvme0n1" || env["DISK_SERIAL"] != "30DF7020FGKL" {
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
	delete(old, "install_disk_serial")
	env := renderTemplate(t, old).Tasks[0].Environment
	// A Workflow without the attest key fails closed: it attests.
	if env["INSTALL"] != "false" || env["INSTALLER_IMAGE"] != "" || env["ATTEST"] != "true" || env["DISK_SERIAL"] != "" {
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
	script, dev := withFakeDisks(t, script, dir,
		fakeDisk{name: "nvme0n1", file: "device/serial", serial: "30DF7020FGKL        \n"},
		fakeDisk{name: "nvme1n1", file: "device/serial", serial: "30LPD1AZPTLL        \n"})
	disk := filepath.Join(dev, "nvme0n1")
	argsFile := filepath.Join(dir, "args")
	os.WriteFile(filepath.Join(dir, "docker"), []byte("#!/bin/sh\nprintf '%s\\n' \"$@\" > "+argsFile+"\n"), 0o755)
	codeFile, wipedFile := filepath.Join(dir, "install_code"), filepath.Join(dir, "wiped")
	os.WriteFile(wipedFile, nil, 0o600)

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
		cmd.Env = append(cmd.Env, "INSTALL="+install, "INSTALL_CODE_FILE="+codeFile, "WIPED_FILE="+wipedFile, "DISK="+disk)
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
	want := "--entrypoint\n/bin/installer\nghcr.io/jonpulsifer/talos-installer-folly:v1.14.4\ninstall\n--platform\nmetal\n--disk\n" + disk + "\n--meta\n0x0b=" + testCode + "\n"
	if !strings.HasSuffix(args, want) || !strings.Contains(args, "type=efivarfs") {
		t.Fatalf("docker ran with:\n%s", args)
	}
	// The other disk took the name: nothing is installed.
	disk = filepath.Join(dev, "nvme1n1")
	if out, err := run("true", testCode); err == nil || !strings.Contains(out, "nothing installed") {
		t.Fatalf("the install went to the disk that took the name: %v %s", err, out)
	}
	disk = filepath.Join(dev, "nvme0n1")
	for _, bad := range []string{"", "short", strings.Repeat("A", 42) + "$", strings.Repeat("A", 44)} {
		if out, err := run("true", bad); err == nil {
			t.Errorf("code %q installed: %s", bad, out)
		}
	}
	if args, err := run("false", testCode); err != nil || args != "" {
		t.Fatalf("a run without install: %v %q", err, args)
	}
	// A run that resumed at install in a new boot finds no mark of this
	// boot's wipe: it names that reason and runs no installer.
	os.Remove(wipedFile)
	for _, code := range []string{testCode, ""} {
		out, err := run("true", code)
		if err == nil || !strings.Contains(out, "this run resumed in a new boot after wipe-disk; nothing installed; set desired_action to provision") {
			t.Errorf("a resumed run with code %q: %v %q", code, err, out)
		}
		if _, statErr := os.Stat(argsFile); statErr == nil {
			t.Errorf("a resumed run with code %q ran docker", code)
		}
	}
	if args, err := run("false", testCode); err != nil || args != "" {
		t.Fatalf("a run without install and without the mark: %v %q", err, args)
	}
}

// wipe-disk marks its wipe for install only once the disk reads blank, in
// the per-boot /worker/fleet that both actions mount.
func TestWipeMarksTheWipeLast(t *testing.T) {
	wf := renderTemplate(t, provisionMap(t))
	if wf.Tasks[0].Environment["WIPED_FILE"] != "/tmp/fleet/wiped" {
		t.Fatalf("WIPED_FILE %q is not under /worker/fleet", wf.Tasks[0].Environment["WIPED_FILE"])
	}
	wipe := actionScripts(t)["wipe-disk"]
	blank := strings.Index(wipe, `if blkid -p "$DISK"; then`)
	mark := strings.Index(wipe, `touch "$WIPED_FILE"`)
	if blank < 0 || mark < blank || strings.Count(wipe, "$WIPED_FILE") != 1 {
		t.Errorf("wipe-disk marks the wipe at %d, before the blank check at %d", mark, blank)
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

// fakeDisk is one disk of a fake /sys/block: its kernel name, the sysfs file
// that reports its serial and that file's bytes, and whether it is removable
// or hangs off USB.
type fakeDisk struct {
	name, file, serial string
	removable, usb     bool
}

// withFakeDisks points a script's disk check at a fake /sys/block under dir,
// and at regular files in a fake /dev for block devices, so the test never
// touches a real disk. It returns the script and the fake /dev.
func withFakeDisks(t *testing.T, script, dir string, disks ...fakeDisk) (string, string) {
	t.Helper()
	dev, block := filepath.Join(dir, "dev"), filepath.Join(dir, "sys", "block")
	write := func(path, s string) {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, d := range disks {
		node := filepath.Join(dir, "sys", "devices", "pci0000:00", "0000:00:17.0", d.name)
		if d.usb {
			node = filepath.Join(dir, "sys", "devices", "pci0000:00", "0000:00:14.0", "usb2", "2-1", d.name)
		}
		removable := "0\n"
		if d.removable {
			removable = "1\n"
		}
		write(filepath.Join(node, d.file), d.serial)
		write(filepath.Join(node, "removable"), removable)
		write(filepath.Join(dev, d.name), "")
		if err := os.MkdirAll(block, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(node, filepath.Join(block, d.name)); err != nil {
			t.Fatal(err)
		}
	}
	if !strings.Contains(script, `[ -b "$DISK" ]`) || !strings.Contains(script, "/sys/block/") {
		t.Fatal("the script has no disk check to point at the fake disks")
	}
	script = strings.ReplaceAll(script, "/sys/block", block)
	script = strings.ReplaceAll(script, `[ -b "$DISK" ]`, `[ -f "$DISK" ]`)
	return script, dev
}

var diskCheck = regexp.MustCompile(`(?s)serial_of\(\) \{\n.*?\n *log "\$DISK reports the serial \$DISK_SERIAL"\n *\}\n`)

func actionScripts(t *testing.T) map[string]string {
	t.Helper()
	scripts := map[string]string{}
	for _, a := range renderTemplate(t, provisionMap(t)).Tasks[0].Actions {
		if len(a.Command) == 3 {
			scripts[a.Name] = a.Command[2]
		}
	}
	return scripts
}

// Each action is its own container, so wipe-disk and install each carry the
// disk check; the two copies must not drift.
func TestTheDiskCheckIsTheSameInWipeAndInstall(t *testing.T) {
	scripts := actionScripts(t)
	wipe, install := diskCheck.FindString(scripts["wipe-disk"]), diskCheck.FindString(scripts["install"])
	if wipe == "" || wipe != install {
		t.Fatalf("wipe-disk's disk check:\n%s\ninstall's:\n%s", wipe, install)
	}
	for name, want := range map[string]string{"wipe-disk": `check_disk "nothing wiped"`, "install": `check_disk "nothing installed"`} {
		if !strings.Contains(scripts[name], want) {
			t.Errorf("%s never runs %s", name, want)
		}
	}
}

// The disk check passes only the disk at the declared kernel name that
// reports the declared serial, which no other disk reports, and which is
// neither removable nor on USB: the cases of a swapped slot, a missing disk
// whose name another disk takes, and a USB stick at sda.
func TestTheDiskCheckFindsTheDeclaredDisk(t *testing.T) {
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("no sh")
	}
	check := diskCheck.FindString(actionScripts(t)["wipe-disk"])
	if check == "" {
		t.Fatal("wipe-disk has no disk check")
	}
	script := "set -eu\nlog() { echo \"wipe: $*\"; }\n" + check + "check_disk \"nothing wiped\"\necho checked\n"
	nvme := func(name, serial string) fakeDisk {
		return fakeDisk{name: name, file: "device/serial", serial: serial + "        \n"}
	}
	sata := func(name, serial string) fakeDisk {
		return fakeDisk{name: name, file: "device/vpd_pg80", serial: "\x00\x80\x00\x14" + fmt.Sprintf("%20s", serial)}
	}
	for _, c := range []struct {
		name, disk, serial string
		disks              []fakeDisk
		want               string
	}{
		{"nvme", "nvme0n1", "30DF7020FGKL", []fakeDisk{nvme("nvme0n1", "30DF7020FGKL"), sata("sda", "04082222U0024")}, "checked"},
		{"sata", "sda", "04082222U0024", []fakeDisk{sata("sda", "04082222U0024")}, "checked"},
		{"virtio", "vda", "tl1sys", []fakeDisk{{name: "vda", file: "serial", serial: "tl1sys"}}, "checked"},
		{"no serial", "nvme0n1", "", []fakeDisk{nvme("nvme0n1", "30DF7020FGKL")}, "no install disk serial is declared for"},
		{"malformed", "nvme0n1", "30DF/7020", []fakeDisk{nvme("nvme0n1", "30DF7020FGKL")}, "is malformed; nothing wiped"},
		{"no disk", "nvme0n1", "30DF7020FGKL", nil, "is not a block device; nothing wiped"},
		{"swapped slots", "nvme0n1", "30DF7020FGKL", []fakeDisk{nvme("nvme0n1", "30LPD1AZPTLL"), nvme("nvme1n1", "30DF7020FGKL")}, "nvme0n1 is nvme0n1, but the disk that reports 30DF7020FGKL is nvme1n1; nothing wiped"},
		{"declared disk missing", "nvme0n1", "30DF7020FGKL", []fakeDisk{nvme("nvme0n1", "30LPD1AZPTLL")}, "no disk reports the serial 30DF7020FGKL; nothing wiped"},
		{"usb stick at sda", "sda", "04082222U0024", []fakeDisk{{name: "sda", file: "device/vpd_pg80", serial: "\x00\x80\x00\x08tl4stick", usb: true, removable: true}}, "no disk reports the serial 04082222U0024"},
		{"two disks, one serial", "sda", "04082222U0024", []fakeDisk{sata("sda", "04082222U0024"), sata("sdb", "04082222U0024")}, "more than one disk reports the serial 04082222U0024 (sda sdb)"},
		{"removable", "sda", "04082222U0024", []fakeDisk{{name: "sda", file: "device/vpd_pg80", serial: "\x00\x80\x00\x0d04082222U0024", removable: true}}, "is removable; nothing wiped"},
		{"usb", "sda", "04082222U0024", []fakeDisk{{name: "sda", file: "device/vpd_pg80", serial: "\x00\x80\x00\x0d04082222U0024", usb: true}}, "is on USB; nothing wiped"},
	} {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			s, dev := withFakeDisks(t, script, dir, c.disks...)
			cmd := exec.Command(sh, "-c", s)
			cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "DISK=" + filepath.Join(dev, c.disk), "DISK_SERIAL=" + c.serial}
			out, err := cmd.CombinedOutput()
			if !strings.Contains(string(out), c.want) || (err == nil) != (c.want == "checked") {
				t.Errorf("%v %q, want %q", err, out, c.want)
			}
		})
	}
	// A partition is no whole disk.
	dir := t.TempDir()
	s, dev := withFakeDisks(t, script, dir, nvme("nvme0n1", "30DF7020FGKL"))
	if err := os.WriteFile(filepath.Join(dev, "nvme0n1p1"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(sh, "-c", s)
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "DISK=" + filepath.Join(dev, "nvme0n1p1"), "DISK_SERIAL=30DF7020FGKL"}
	if out, err := cmd.CombinedOutput(); err == nil || !strings.Contains(string(out), "is not a whole disk") {
		t.Errorf("a partition: %v %q", err, out)
	}
}

func TestInstallRunsTheInstallerWithoutPulling(t *testing.T) {
	scripts := actionScripts(t)
	if !strings.Contains(scripts["install"], "docker run --rm --pull never --name provision-install") {
		t.Error("install can pull the installer after the wipe")
	}
	if strings.Contains(scripts["install"], "docker pull") {
		t.Error("install pulls the installer")
	}
	if !strings.Contains(scripts["wipe-disk"], `docker pull -q "$INSTALLER_IMAGE"`) {
		t.Error("wipe-disk does not pull the installer")
	}
}

// TestWipeFetchesTheInstallerFirst runs wipe-disk against a docker whose pull
// fails: a run that installs refuses to wipe, and a run that does not install
// pulls nothing.
func TestWipeFetchesTheInstallerFirst(t *testing.T) {
	wf := renderTemplate(t, provisionMap(t))
	script := actionScripts(t)["wipe-disk"]
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("no sh")
	}
	dir := t.TempDir()
	script = strings.ReplaceAll(script, "/dev/tty0 /dev/ttyS0", filepath.Join(dir, "console"))
	efi := filepath.Join(dir, "efivars")
	if err := os.Mkdir(efi, 0o755); err != nil {
		t.Fatal(err)
	}
	script = strings.ReplaceAll(script, "/sys/firmware/efi/efivars", efi)
	script, dev := withFakeDisks(t, script, dir,
		fakeDisk{name: "nvme0n1", file: "device/serial", serial: "30DF7020FGKL        \n"})
	bin := filepath.Join(dir, "bin")
	if err := os.Mkdir(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	stub := "#!/bin/sh\nif [ \"$1\" = image ]; then exit 1; fi\nif [ \"$1\" = pull ]; then echo 'manifest unknown'; exit 1; fi\nexit 0\n"
	if err := os.WriteFile(filepath.Join(bin, "docker"), []byte(stub), 0o755); err != nil {
		t.Fatal(err)
	}
	attested, code := filepath.Join(dir, "attested"), filepath.Join(dir, "install_code")
	os.WriteFile(attested, nil, 0o600)
	os.WriteFile(code, []byte(testCode), 0o600)
	run := func(install, image string) string {
		cmd := exec.Command(sh, "-c", script)
		cmd.Env = []string{"PATH=" + bin + ":" + os.Getenv("PATH")}
		for k, v := range wf.Tasks[0].Environment {
			cmd.Env = append(cmd.Env, k+"="+v)
		}
		cmd.Env = append(cmd.Env, "WIPE=true", "INSTALL="+install, "INSTALLER_IMAGE="+image, "ATTESTED_FILE="+attested, "INSTALL_CODE_FILE="+code, "WIPED_FILE="+filepath.Join(dir, "wiped"), "DISK="+filepath.Join(dev, "nvme0n1"))
		out, _ := cmd.CombinedOutput()
		return string(out)
	}
	if out := run("true", "ghcr.io/x/y:v1"); !strings.Contains(out, "cannot be pulled (manifest unknown); nothing wiped") || strings.Contains(out, "wiping every partition") {
		t.Errorf("an unpullable installer did not stop the wipe: %q", out)
	}
	if out := run("true", ""); !strings.Contains(out, "no installer image is declared; nothing wiped") {
		t.Errorf("an empty installer image did not stop the wipe: %q", out)
	}
	if out := run("false", "ghcr.io/x/y:v1"); strings.Contains(out, "pulling") || !strings.Contains(out, "wiping every partition") {
		t.Errorf("a run without install fetched an installer: %q", out)
	}
}

// The installer writes EFI variables after the wipe, so wipe-disk proves the
// variable store takes a write before it touches the disk, and refuses with
// the disk untouched when it does not.
func TestWipeProbesTheEFIStoreBeforeWiping(t *testing.T) {
	script := actionScripts(t)["wipe-disk"]
	probe := strings.Index(script, "refuses to store EFI variables")
	wipe := strings.Index(script, "wipefs --all")
	if probe < 0 || wipe < 0 || probe > wipe {
		t.Fatalf("the EFI write probe (%d) does not precede the wipe (%d)", probe, wipe)
	}
	wf := renderTemplate(t, provisionMap(t))
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("no sh")
	}
	dir := t.TempDir()
	script = strings.ReplaceAll(script, "/dev/tty0 /dev/ttyS0", filepath.Join(dir, "console"))
	script = strings.ReplaceAll(script, "/sys/firmware/efi/efivars", filepath.Join(dir, "no-such-efivars"))
	script, dev := withFakeDisks(t, script, dir,
		fakeDisk{name: "nvme0n1", file: "device/serial", serial: "30DF7020FGKL        \n"})
	attested, code := filepath.Join(dir, "attested"), filepath.Join(dir, "install_code")
	os.WriteFile(attested, nil, 0o600)
	os.WriteFile(code, []byte(testCode), 0o600)
	bin := filepath.Join(dir, "bin")
	if err := os.Mkdir(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "docker"), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(sh, "-c", script)
	cmd.Env = []string{"PATH=" + bin + ":" + os.Getenv("PATH")}
	for k, v := range wf.Tasks[0].Environment {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	cmd.Env = append(cmd.Env, "WIPE=true", "INSTALL=true", "INSTALLER_IMAGE=ghcr.io/x/y:v1", "ATTESTED_FILE="+attested, "INSTALL_CODE_FILE="+code, "WIPED_FILE="+filepath.Join(dir, "wiped"), "DISK="+filepath.Join(dev, "nvme0n1"))
	out, err := cmd.CombinedOutput()
	if err == nil || !strings.Contains(string(out), "refuses to store EFI variables") || !strings.Contains(string(out), "nothing wiped") || strings.Contains(string(out), "wiping every partition") {
		t.Errorf("an EFI store that refuses writes did not stop the wipe: %v %q", err, out)
	}
}

// The Talos installer leaves efivarfs read-only, so next-boot remounts it,
// sets BootOrder and BootNext, and fails the run unless both read back.
func TestNextBootSetsAndVerifiesTheBootEntry(t *testing.T) {
	script := actionScripts(t)["next-boot"]
	for _, want := range []string{
		"mount -o remount,rw /sys/firmware/efi/efivars",
		`efibootmgr -q -o "$n$order"`,
		`efibootmgr -q -n "$n"`,
		`[ "$got_next" = "$n" ] || fail`,
		`fail "BootOrder reads back`,
	} {
		if !strings.Contains(script, want) {
			t.Errorf("next-boot lacks %q", want)
		}
	}
	if strings.Contains(script, "did not mount ($err); the firmware") {
		t.Error("next-boot still tolerates an EFI failure")
	}
}

// fakeEFI is a disk's GPT for a fake sgdisk and a firmware's boot entries for
// a fake efibootmgr, which records deletions, BootOrder and BootNext.
type fakeEFI struct {
	table   string
	parts   map[string]string
	entries []string
	order   string
	failOn  string
}

const (
	espType     = "C12A7328-F81F-11D2-BA4B-00A0C93EC93B"
	talosESP    = "8E70B06A-7E39-4DAF-B175-0BB9DD0A9F73"
	ubuntuESP   = "6EC49856-4F1B-4B8F-9E3B-1C2B6E5E0F15"
	otherESP    = "1D0C2B6E-0000-4000-8000-0000000000AA"
	windowsESP  = "2E1D3C7F-0000-4000-8000-0000000000BB"
	pxeEntry    = "Boot0003* UEFI PXEv4 (MAC:5254007E0001)\tPciRoot(0x0)/Pci(0x3,0x0)/MAC(5254007E0001,0x1)/IPv4(0.0.0.0,0x0,DHCP,0.0.0.0,0.0.0.0,0.0.0.0)"
	windowsBoot = "Boot000A* Windows Boot Manager\tHD(1,GPT," + windowsESP + ",0x800,0x32000)/\\EFI\\Microsoft\\Boot\\bootmgfw.efi"
	lowerUbuntu = "Boot000B* ubuntu\tHD(1,GPT," + otherESP + ",0x800,0x32000)/\\EFI\\ubuntu\\shimx64.efi"
)

func talosEntry(n, guid string) string {
	return "Boot" + n + "* Talos Linux UKI\tHD(1,GPT," + guid + ",0x800,0x41a800)/\\EFI\\boot\\BOOTX64.efi"
}

func ubuntuEntry(n, guid string) string {
	return "Boot" + n + "* Ubuntu\tHD(15,GPT," + guid + ",0x2800,0x35000)/\\EFI\\ubuntu\\shimx64.efi"
}

func partInfo(typeGUID, unique, name string) string {
	return "Partition GUID code: " + typeGUID + " (type)\nPartition unique GUID: " + unique + "\nFirst sector: 2048\nPartition name: '" + name + "'\n"
}

var talosDisk = fakeEFI{
	table: "Disk /dev/nvme0n1: 16777216 sectors, 8.0 GiB\nNumber  Start (sector)    End (sector)  Size       Code  Name\n" +
		"   1            2048         4306943   2.1 GiB     EF00  EFI\n   2         4306944         4308991   1024.0 KiB  8300  META\n   3         4308992         4513791   100.0 MiB   8300  STATE\n",
	parts: map[string]string{
		"1": partInfo(espType, talosESP, "EFI"),
		"2": partInfo("0FC63DAF-8483-4772-8E79-3D69D8477DE4", "11111111-0000-4000-8000-000000000002", "META"),
		"3": partInfo("0FC63DAF-8483-4772-8E79-3D69D8477DE4", "11111111-0000-4000-8000-000000000003", "STATE"),
	},
}

// Ubuntu's cloud image puts its ESP at 15 and names it nothing.
var ubuntuDisk = fakeEFI{
	table: "Disk /dev/nvme0n1: 16777216 sectors, 8.0 GiB\nNumber  Start (sector)    End (sector)  Size       Code  Name\n" +
		"   1         2099200        16777182   7.0 GiB     8300  \n  14            2048           10239   4.0 MiB     EF02  \n  15           10240          227327   106.0 MiB   EF00  \n  16          227328         2097152   913.0 MiB   EA00  \n",
	parts: map[string]string{
		"1":  partInfo("0FC63DAF-8483-4772-8E79-3D69D8477DE4", "22222222-0000-4000-8000-000000000001", ""),
		"14": partInfo("21686148-6449-6E6F-744E-656564454649", "22222222-0000-4000-8000-000000000014", ""),
		"15": partInfo(espType, ubuntuESP, ""),
		"16": partInfo("BC13C2FF-59E6-4262-A352-B275FD6F7172", "22222222-0000-4000-8000-000000000016", ""),
	},
}

type nextBootResult struct {
	out, next, order string
	deleted, entries []string
	err              error
}

// runNextBoot runs next-boot's shell against a mount that does nothing and
// fake sgdisk and efibootmgr tools.
func runNextBoot(t *testing.T, install, wipe, retire string, efi fakeEFI) nextBootResult {
	t.Helper()
	wf := renderTemplate(t, provisionMap(t))
	script := actionScripts(t)["next-boot"]
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("no sh")
	}
	dir := t.TempDir()
	script = strings.ReplaceAll(script, "/dev/tty0 /dev/ttyS0", filepath.Join(dir, "console"))
	bin, state := filepath.Join(dir, "bin"), filepath.Join(dir, "state")
	for _, d := range []string{bin, state} {
		if err := os.Mkdir(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write := func(path, s string, mode os.FileMode) {
		if err := os.WriteFile(path, []byte(s), mode); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(state, "table"), efi.table, 0o644)
	for n, info := range efi.parts {
		write(filepath.Join(state, "part"+n), info, 0o644)
	}
	write(filepath.Join(state, "entries"), strings.Join(efi.entries, "\n")+"\n", 0o644)
	write(filepath.Join(state, "order"), efi.order, 0o644)
	write(filepath.Join(state, "deleted"), "", 0o644)
	write(filepath.Join(bin, "sgdisk"), "#!/bin/sh\nS="+state+"\ncase \"$1\" in -p) cat $S/table ;; -i) cat $S/part$2 ;; esac\n", 0o755)
	write(filepath.Join(bin, "efibootmgr"), `#!/bin/sh
S=`+state+`
case "$*" in
  ""|-v)
    [ -s $S/next ] && echo "BootNext: $(cat $S/next)"
    echo "BootCurrent: 0003"
    echo "BootOrder: $(cat $S/order)"
    cat $S/entries ;;
  "-q -b "*" -B")
    if [ "$3" = "`+efi.failOn+`" ]; then echo "Could not delete variable: Read-only file system" >&2; exit 5; fi
    grep -v "^Boot$3" $S/entries >$S/e; mv $S/e $S/entries; echo "$3" >>$S/deleted ;;
  "-q -o "*) echo "$3" >$S/order ;;
  "-q -n "*) echo "$3" >$S/next ;;
  *) exit 2 ;;
esac
`, 0o755)
	// Some sh wrappers put setuid wrappers such as mount ahead of PATH, and
	// functions win over both.
	cmd := exec.Command(sh, "-c", "mount() { :; }\nmountpoint() { :; }\n"+script)
	cmd.Env = []string{"PATH=" + bin + ":" + os.Getenv("PATH")}
	for k, v := range wf.Tasks[0].Environment {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	cmd.Env = append(cmd.Env, "INSTALL="+install, "WIPE="+wipe, "RETIRE="+retire)
	out, err := cmd.CombinedOutput()
	read := func(name string) string {
		b, _ := os.ReadFile(filepath.Join(state, name))
		return strings.TrimSpace(string(b))
	}
	var r nextBootResult
	r.out, r.err, r.next, r.order = string(out), err, read("next"), read("order")
	r.deleted = strings.Fields(read("deleted"))
	for _, line := range strings.Split(read("entries"), "\n") {
		if len(line) >= 8 {
			r.entries = append(r.entries, line[4:8])
		}
	}
	return r
}

// next-boot keeps the one fleet OS entry on this install's EFI system
// partition, found by its type, and deletes every other entry a fleet OS
// made: after an OS change, a retirement or a wipe, none of another disk's or
// an erased one's stays. Entries no fleet OS made stay.
func TestNextBootKeepsOnlyThisInstallsFleetEntry(t *testing.T) {
	if got := renderTemplate(t, provisionMap(t)).Tasks[0].Environment["FLEET_OS_ENTRIES"]; got != "Talos Linux UKI|Ubuntu" {
		t.Fatalf("FLEET_OS_ENTRIES %q", got)
	}
	mixed := []string{pxeEntry, talosEntry("0007", talosESP), ubuntuEntry("0008", ubuntuESP), talosEntry("0009", otherESP), windowsBoot, lowerUbuntu,
		"Boot000C* Ubuntu-rescue\tHD(1,GPT," + otherESP + ",0x800,0x32000)/\\EFI\\rescue.efi"}
	order := "0003,0008,0007,0009,000A,000B,000C"
	for _, c := range []struct {
		name                  string
		install, wipe, retire string
		disk                  fakeEFI
		next                  string
		deleted, kept         []string
		ok                    bool
		want                  string
	}{
		{"talos after ubuntu", "true", "true", "false", talosDisk, "0007", []string{"0008", "0009"}, []string{"0003", "0007", "000A", "000B", "000C"}, true, "Boot0007 (the installed disk) is the next boot"},
		{"ubuntu after talos", "true", "true", "false", ubuntuDisk, "0008", []string{"0007", "0009"}, []string{"0003", "0008", "000A", "000B", "000C"}, true, "Boot0008 (the installed disk) is the next boot"},
		{"wipe", "false", "true", "false", talosDisk, "0003", []string{"0007", "0008", "0009"}, []string{"0003", "000A", "000B", "000C"}, true, "Boot0003 (IPv4 network) is the next boot"},
		{"retire", "false", "true", "true", talosDisk, "", []string{"0007", "0008", "0009"}, []string{"0003", "000A", "000B", "000C"}, true, "a retired node powers off; no next boot"},
		{"attest", "false", "false", "false", talosDisk, "", nil, []string{"0003", "0007", "0008", "0009", "000A", "000B", "000C"}, true, "nothing installed or wiped"},
	} {
		t.Run(c.name, func(t *testing.T) {
			c.disk.entries, c.disk.order = mixed, order
			r := runNextBoot(t, c.install, c.wipe, c.retire, c.disk)
			if (r.err == nil) != c.ok || !strings.Contains(r.out, c.want) {
				t.Fatalf("%v %q, want %q", r.err, r.out, c.want)
			}
			if strings.Join(r.deleted, ",") != strings.Join(c.deleted, ",") || strings.Join(r.entries, ",") != strings.Join(c.kept, ",") {
				t.Errorf("deleted %v, left %v; want deleted %v, left %v", r.deleted, r.entries, c.deleted, c.kept)
			}
			if r.next != c.next || (c.next != "" && !strings.HasPrefix(r.order, c.next+",")) {
				t.Errorf("BootNext %q, BootOrder %q; want %s first", r.next, r.order, c.next)
			}
		})
	}
	// An install whose ESP no entry names fails before it deletes anything.
	disk := talosDisk
	disk.entries, disk.order = []string{pxeEntry, talosEntry("0009", otherESP), ubuntuEntry("0008", ubuntuESP)}, "0003,0008,0009"
	if r := runNextBoot(t, "true", "true", "false", disk); r.err == nil || !strings.Contains(r.out, "no boot entry names") || len(r.deleted) != 0 {
		t.Errorf("an install without its entry: %v %q, deleted %v", r.err, r.out, r.deleted)
	}
	// A disk with no EFI system partition fails the install.
	disk = ubuntuDisk
	disk.parts = map[string]string{"1": ubuntuDisk.parts["1"], "14": ubuntuDisk.parts["14"], "15": ubuntuDisk.parts["16"], "16": ubuntuDisk.parts["16"]}
	disk.entries, disk.order = mixed, order
	if r := runNextBoot(t, "true", "true", "false", disk); r.err == nil || !strings.Contains(r.out, "has no EFI system partition; the run fails") {
		t.Errorf("a disk without an ESP: %v %q", r.err, r.out)
	}
	// A refused deletion fails an install, and a retirement still powers off.
	disk = talosDisk
	disk.entries, disk.order, disk.failOn = mixed, order, "0008"
	if r := runNextBoot(t, "true", "true", "false", disk); r.err == nil || !strings.Contains(r.out, "the stale entry Boot0008 cannot be deleted") || r.next != "" {
		t.Errorf("an install whose stale entry stays: %v %q", r.err, r.out)
	}
	if r := runNextBoot(t, "false", "true", "true", disk); r.err != nil || !strings.Contains(r.out, "the retired node powers off with its boot entries as they are") {
		t.Errorf("a retirement whose stale entry stays: %v %q", r.err, r.out)
	}
}
