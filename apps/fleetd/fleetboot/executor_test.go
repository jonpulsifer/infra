package fleetboot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/jonpulsifer/infra/apps/fleetd/protocol"
)

// serveImage serves a raw disk image with an EFI system partition over
// TLS, and answers the run that installs it.
func serveImage(t *testing.T, m *machine) (*httptest.Server, protocol.BootRun) {
	t.Helper()
	img := makeGPT(t, 8192, []testPart{
		{TypeESP, espGUID, 2048, 4095, "ESP"},
		{TypeLinuxRoot, rootGUID, 4096, 8158, "root"},
	})
	sum := sha256.Sum256(img)
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write(img)
	}))
	t.Cleanup(srv.Close)
	r := imageRun()
	r.Disk = m.disk
	r.ImageURL = srv.URL + "/nixos.img"
	r.ImageDigest = "sha256:" + hex.EncodeToString(sum[:])
	r.ImageFormat = "raw"
	r.SeedURL = "https://enroll.example/seed"
	return srv, r
}

// A NixOS provision wipes the disk that reports the serial, writes the
// image, drops fleet-seed.json on its ESP, makes the ESP's new entry the
// next boot, and reboots, reporting each step before the next.
func TestRunInstallsAnImage(t *testing.T) {
	m := newMachine(t, 16<<20)
	m.addPart("nvme0n1", 1, 2048, 2048)
	m.efiVars.entries = []BootEntry{
		{Num: "0001", Active: true, Label: "Talos Linux UKI", Path: "HD(1,GPT,aaaaaaaa-0000-4000-8000-000000000001,0x800,0x32000)"},
		{Num: "0002", Active: true, Label: "UEFI: IPV4 Intel", Path: "MAC(001122334455,0)/IPv4(0.0.0.0,0,DHCP)"},
	}
	m.efiVars.order = []string{"0001", "0002"}
	srv, run := serveImage(t, m)
	rep := &reports{}
	e := m.executor(rep)
	e.HTTP = srv.Client()
	if err := e.Run(context.Background(), run); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"wipe started", "wipe succeeded", "install started", "install succeeded",
		"next-boot started", "next-boot succeeded", "reboot started", "reboot succeeded",
	}
	if got := rep.phases(); !reflect.DeepEqual(got, want) {
		t.Errorf("reports %v, want %v", got, want)
	}
	for _, c := range []string{"wipefs --all --force " + m.disk, "sgdisk --zap-all " + m.disk, "sgdisk -e " + m.disk} {
		if !m.ran(c) {
			t.Errorf("did not run %s", c)
		}
	}
	var seed seedFile
	b, err := os.ReadFile(filepath.Join(m.ram, "esp", "fleet-seed.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &seed); err != nil || seed.URL != run.SeedURL || seed.UUID != e.UUID || seed.Code != e.Code {
		t.Errorf("fleet-seed.json %s", b)
	}
	vfat := 0
	for _, mnt := range m.mounts {
		if strings.HasSuffix(mnt, " vfat") {
			vfat++
		}
	}
	if vfat != 1 {
		t.Errorf("mounts %v: want the ESP once", m.mounts)
	}
	efi := m.efiVars
	if efi.created != 1 || efi.next == "" || efi.order[0] != efi.next {
		t.Errorf("boot vars %+v", efi)
	}
	for _, en := range efi.entries {
		if en.Label == "Talos Linux UKI" {
			t.Error("the stale Talos entry stays")
		}
	}
	if m.rebooted != "reboot" {
		t.Errorf("rebooted %q", m.rebooted)
	}
	disk, _ := os.ReadFile(m.disk)
	if string(disk[512:520]) != "EFI PART" {
		t.Error("the image is not on the disk")
	}
	if _, err := os.Stat(filepath.Join(m.ram, "image")); !os.IsNotExist(err) {
		t.Error("the download stays in memory")
	}
}

// An image whose digest differs is never written: the disk stays wiped,
// the run reports the install failed, and nothing reboots.
func TestRunRefusesAnImageWithAnotherDigest(t *testing.T) {
	m := newMachine(t, 16<<20)
	srv, run := serveImage(t, m)
	run.ImageDigest = "sha256:" + strings.Repeat("0", 64)
	rep := &reports{}
	e := m.executor(rep)
	e.HTTP = srv.Client()
	err := e.Run(context.Background(), run)
	if err == nil || !strings.Contains(err.Error(), "nothing written") {
		t.Fatalf("err %v", err)
	}
	if got := rep.phases(); !reflect.DeepEqual(got, []string{"wipe started", "wipe succeeded", "install started", "install failed"}) {
		t.Errorf("reports %v", got)
	}
	if m.rebooted != "" || m.ran("efibootmgr") {
		t.Error("a failed install went on")
	}
}

// A disk that does not report the serial is never wiped.
func TestRunRefusesAnotherDisk(t *testing.T) {
	m := newMachine(t, 16<<20)
	m.addDisk("sda", "WD-OTHER", 1<<20)
	run := protocol.BootRun{Run: "wipe-x-1", Action: "wipe", Wipe: true, Disk: filepath.Join(m.dev, "sda"), DiskSerial: "S5GXNX0R123456"}
	rep := &reports{}
	err := m.executor(rep).Run(context.Background(), run)
	if err == nil || !strings.Contains(err.Error(), "the disk that reports S5GXNX0R123456 is nvme0n1; nothing wiped") {
		t.Fatalf("err %v", err)
	}
	if m.ran("wipefs") || m.ran("sgdisk") {
		t.Error("the other disk was wiped")
	}
}

// fleetd not taking a step's start stops the run before the step.
func TestRunStopsWhenFleetdTakesNoReport(t *testing.T) {
	m := newMachine(t, 16<<20)
	rep := &reports{failAt: "wipe started"}
	run := protocol.BootRun{Run: "wipe-x-1", Action: "wipe", Wipe: true, Disk: m.disk, DiskSerial: "S5GXNX0R123456"}
	if err := m.executor(rep).Run(context.Background(), run); err == nil {
		t.Fatal("the run went on")
	}
	if m.ran("wipefs") {
		t.Error("the disk was wiped without fleetd knowing")
	}
}

// A wipe with no install boots the network next.
func TestRunWipeBootsTheNetwork(t *testing.T) {
	m := newMachine(t, 16<<20)
	m.addPart("nvme0n1", 1, 2048, 2048)
	m.efiVars.entries = []BootEntry{
		{Num: "0001", Active: true, Label: "fleet nixos", Path: "HD(1,GPT," + espGUID + ",0x800,0x800)"},
		{Num: "0002", Active: true, Label: "UEFI: IPV4 Intel", Path: "IPv4(0.0.0.0,0,DHCP)"},
	}
	m.efiVars.order = []string{"0001", "0002"}
	rep := &reports{}
	run := protocol.BootRun{Run: "wipe-x-1", Action: "wipe", Wipe: true, Disk: m.disk, DiskSerial: "S5GXNX0R123456"}
	if err := m.executor(rep).Run(context.Background(), run); err != nil {
		t.Fatal(err)
	}
	if m.efiVars.next != "0002" || len(m.efiVars.entries) != 1 {
		t.Errorf("boot vars %+v: the network boots next and the old fleet entry goes", m.efiVars)
	}
	if !m.ran("wipefs --all --force " + filepath.Join(m.dev, "nvme0n1p1")) {
		t.Error("the partition was not wiped")
	}
}

// A retirement's erase passes only on evidence: a discard the device
// ignores leaves the canaries, and the zeroing that follows erases them.
func TestRetireEraseNeedsEvidence(t *testing.T) {
	const size = 512 << 20
	m := newMachine(t, size)
	m.addPart("nvme0n1", 1, 2048, 262144)
	discards := 0
	m.run["blkdiscard"] = func(args []string) ([]byte, error) {
		switch {
		case args[0] == "--secure":
			return []byte("BLKSECDISCARD: Operation not supported"), errUnsupported
		case args[0] == "--zeroout":
			var off, n int64
			for i := 0; i+1 < len(args); i++ {
				switch args[i] {
				case "--offset":
					off = atoi(t, args[i+1])
				case "--length":
					n = atoi(t, args[i+1])
				}
			}
			punch(t, m.disk, off, n)
			return nil, nil
		}
		discards++
		return nil, nil
	}
	m.run["nvme"] = func([]string) ([]byte, error) { return nil, errUnsupported }
	rep := &reports{}
	run := protocol.BootRun{Run: "retire-x-1", Action: "retire", Wipe: true, Retire: true, Disk: m.disk, DiskSerial: "S5GXNX0R123456"}
	if err := m.executor(rep).Run(context.Background(), run); err != nil {
		t.Fatal(err)
	}
	if discards != 1 || !m.ran("blkdiscard --zeroout") {
		t.Errorf("discards %d; the ignored discard must lead to the zeroing", discards)
	}
	if m.rebooted != "off" {
		t.Errorf("a retired node %q, want off", m.rebooted)
	}
}

func atoi(t *testing.T, s string) int64 {
	t.Helper()
	n, err := json.Number(s).Int64()
	if err != nil {
		t.Fatal(err)
	}
	return n
}
