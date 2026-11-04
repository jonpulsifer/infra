package fleetboot

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jonpulsifer/infra/apps/fleetd/protocol"
)

// The download's budget is the memory the kernel says is available, less a
// quarter and the write's headroom, within the tmpfs's free space.
func TestMemoryBudget(t *testing.T) {
	info := []byte("MemTotal:       16384000 kB\nMemFree:         1000000 kB\nMemAvailable:    8388608 kB\n")
	got, err := MemoryBudget(info, 1<<40)
	if err != nil {
		t.Fatal(err)
	}
	if want := int64(8388608)*1024*3/4 - writeHeadroom; got != want {
		t.Errorf("budget %d, want %d", got, want)
	}
	if got, _ := MemoryBudget(info, 1<<30); got != 1<<30 {
		t.Errorf("budget %d over the tmpfs's free space", got)
	}
	if got, _ := MemoryBudget([]byte("MemAvailable:  100 kB\n"), 1<<40); got != 0 {
		t.Errorf("a machine with no memory to spare has budget %d", got)
	}
	if _, err := MemoryBudget([]byte("MemTotal: 1 kB\n"), 1); err == nil {
		t.Error("a meminfo with no MemAvailable has a budget")
	}
}

// Only blkid's "nothing found" proves the wipe; a blkid that cannot run
// fails it.
func TestWipeNeedsBlkidsAnswer(t *testing.T) {
	m := newMachine(t, 16<<20)
	m.run["blkid"] = func([]string) ([]byte, error) {
		return nil, errors.New(`exec: "blkid": executable file not found in $PATH`)
	}
	rep := &reports{}
	run := protocol.BootRun{Run: "wipe-x-1", Action: "wipe", Wipe: true, Disk: m.disk, DiskSerial: "S5GXNX0R123456"}
	err := m.executor(rep).Run(context.Background(), run)
	if err == nil || !strings.Contains(err.Error(), "blkid could not check") {
		t.Fatalf("err %v", err)
	}
	if got := rep.phases(); !reflect.DeepEqual(got, []string{"wipe started", "wipe failed"}) {
		t.Errorf("reports %v", got)
	}
}

// A refused run reports its wipe started and failed, so fleetd records why
// it stopped; a failure fleetd does not take is part of the error.
func TestPreflightRefusalIsReported(t *testing.T) {
	m := newMachine(t, 16<<20)
	run := imageRun()
	run.ImageDigest = "sha256:abc"
	rep := &reports{}
	if err := m.executor(rep).Run(context.Background(), run); err == nil {
		t.Fatal("a malformed run ran")
	}
	if got := rep.phases(); !reflect.DeepEqual(got, []string{"wipe started", "wipe failed"}) || !strings.Contains(rep.got[1].Detail, "nothing wiped") {
		t.Errorf("reports %v %+v", got, rep.got)
	}
	if m.ran("wipefs") {
		t.Error("a refused run wiped")
	}
	rep = &reports{failAt: "wipe failed"}
	err := m.executor(rep).Run(context.Background(), run)
	if err == nil || !strings.Contains(err.Error(), "fleetd did not take the failure") {
		t.Errorf("err %v", err)
	}
}

// An efivarfs that stays read-only is named as such, apart from a firmware
// that refuses the probe's write, and nothing is wiped.
func TestReadOnlyEFIVarsWipesNothing(t *testing.T) {
	m := newMachine(t, 16<<20)
	m.remountErr = errors.New("mount: permission denied")
	srv, run := serveImage(t, m)
	e := m.executor(&reports{})
	e.HTTP = srv.Client()
	err := e.Run(context.Background(), run)
	if err == nil || !strings.Contains(err.Error(), "efivarfs stays read-only (mount: permission denied); nothing wiped") {
		t.Fatalf("err %v", err)
	}
	if m.ran("wipefs") {
		t.Error("the disk was wiped")
	}
}

// A wipe gets the image Template's 300 s and a retirement's the provision
// Template's 900 s, and a run's steps fit the Templates' 1,800 s global
// timeout, which fleetd's run deadline is.
func TestStepTimeouts(t *testing.T) {
	e := &Executor{}
	if e.timeout(protocol.StepWipe, protocol.BootRun{}) != 300*time.Second || e.timeout(protocol.StepWipe, protocol.BootRun{Retire: true}) != 900*time.Second {
		t.Error("wipe timeouts")
	}
	var sum time.Duration
	for _, d := range StepTimeouts {
		sum += d
	}
	if sum >= 1800*time.Second {
		t.Errorf("an install's steps take up to %s, past the 1,800 s deadline", sum)
	}
	retire := RetireWipeTimeout + StepTimeouts[protocol.StepNextBoot] + StepTimeouts[protocol.StepReboot]
	if retire >= 1800*time.Second {
		t.Errorf("a retirement's steps take up to %s", retire)
	}
}

func TestMountpointIn(t *testing.T) {
	info := []byte("22 1 0:21 / /sys/firmware/efi/efivars rw,nosuid - efivarfs efivarfs rw\n23 1 0:22 / /run/a\\040b rw - tmpfs tmpfs rw\n")
	if !mountpointIn(info, "/sys/firmware/efi/efivars") || !mountpointIn(info, "/run/a b") || mountpointIn(info, "/sys") {
		t.Error("mountpointIn")
	}
}

// xzTar packs files, in order, into a tar.xz.
func xzTar(t *testing.T, files ...[]byte) []byte {
	t.Helper()
	if _, err := exec.LookPath("xz"); err != nil {
		t.Skip("no xz")
	}
	var b bytes.Buffer
	w := tar.NewWriter(&b)
	for i, f := range files {
		if err := w.WriteHeader(&tar.Header{Name: []string{"disk.raw", "extra"}[i], Mode: 0o644, Size: int64(len(f)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		w.Write(f)
	}
	w.Close()
	cmd := exec.Command("xz", "-c")
	cmd.Stdin = &b
	out, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// A tar.xz is unpacked once: its one member goes to the disk, and a second
// header fails the install.
func TestTarXZImage(t *testing.T) {
	img := makeGPT(t, 8192, []testPart{{TypeESP, espGUID, 2048, 4095, "ESP"}})
	for name, c := range map[string]struct {
		tarball []byte
		ok      bool
	}{
		"one member":  {xzTar(t, img), true},
		"two members": {xzTar(t, img, []byte("x")), false},
	} {
		m := newMachine(t, 16<<20)
		m.addPart("nvme0n1", 1, 2048, 2048)
		sum := sha256.Sum256(c.tarball)
		srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.Write(c.tarball) }))
		run := imageRun()
		run.Disk, run.ImageURL, run.ImageFormat = m.disk, srv.URL+"/i.tar.xz", "tar.xz"
		run.ImageDigest = "sha256:" + hex.EncodeToString(sum[:])
		e := m.executor(&reports{})
		e.HTTP = srv.Client()
		err := e.Run(context.Background(), run)
		srv.Close()
		if c.ok && err != nil {
			t.Errorf("%s: %v", name, err)
		}
		if !c.ok && (err == nil || !strings.Contains(err.Error(), "second member")) {
			t.Errorf("%s: %v", name, err)
		}
	}
}
