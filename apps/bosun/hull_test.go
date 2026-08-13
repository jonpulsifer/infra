package main

import (
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("writing %s: %v", path, err)
	}
}

// writeTestHull writes a minimal hull directory (hull.json, kernel, initrd)
// under dir/name and returns its path.
func writeTestHull(t *testing.T, dir, name string, devices []hullDevice) string {
	t.Helper()
	hullDir := filepath.Join(dir, name)
	if err := os.MkdirAll(hullDir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", hullDir, err)
	}
	writeFile(t, filepath.Join(hullDir, "vmlinux"), "kernel-bytes")
	writeFile(t, filepath.Join(hullDir, "initrd"), "initrd-bytes")
	m := hullManifest{Kernel: "vmlinux", Initrd: "initrd", Cmdline: "console=ttyS0", Devices: devices}
	raw, err := json.Marshal(m)
	if err != nil {
		t.Fatalf("marshal hull manifest: %v", err)
	}
	writeFile(t, filepath.Join(hullDir, "hull.json"), string(raw))
	return hullDir
}

func TestHullDigestStableAndCoversNamedFiles(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "vmlinux"), "kernel-bytes")
	writeFile(t, filepath.Join(dir, "initrd"), "initrd-bytes")
	writeFile(t, filepath.Join(dir, "hull.json"), `{"kernel":"vmlinux","initrd":"initrd","cmdline":"console=ttyS0"}`)

	h1, err := loadHull(dir)
	if err != nil {
		t.Fatalf("loadHull: %v", err)
	}
	if h1.digest == "" {
		t.Fatal("digest is empty")
	}
	h2, err := loadHull(dir)
	if err != nil {
		t.Fatalf("loadHull: %v", err)
	}
	if h1.digest != h2.digest {
		t.Fatalf("digest not stable across loads: %s != %s", h1.digest, h2.digest)
	}

	writeFile(t, filepath.Join(dir, "vmlinux"), "different-kernel-bytes")
	h3, err := loadHull(dir)
	if err != nil {
		t.Fatalf("loadHull: %v", err)
	}
	if h3.digest == h1.digest {
		t.Fatal("digest did not change when kernel content changed")
	}
	writeFile(t, filepath.Join(dir, "vmlinux"), "kernel-bytes")

	writeFile(t, filepath.Join(dir, "initrd"), "different-initrd-bytes")
	h4, err := loadHull(dir)
	if err != nil {
		t.Fatalf("loadHull: %v", err)
	}
	if h4.digest == h1.digest {
		t.Fatal("digest did not change when initrd content changed")
	}
	writeFile(t, filepath.Join(dir, "initrd"), "initrd-bytes")

	writeFile(t, filepath.Join(dir, "hull.json"), `{"kernel":"vmlinux","initrd":"initrd","cmdline":"console=ttyS1"}`)
	h5, err := loadHull(dir)
	if err != nil {
		t.Fatalf("loadHull: %v", err)
	}
	if h5.digest == h1.digest {
		t.Fatal("digest did not change when cmdline changed")
	}
}

func TestHullDigestCoversDiskContent(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "vmlinux"), "kernel-bytes")
	writeFile(t, filepath.Join(dir, "initrd"), "initrd-bytes")
	writeFile(t, filepath.Join(dir, "rootfs.img"), "rootfs-bytes")
	manifest := `{"kernel":"vmlinux","initrd":"initrd","cmdline":"console=ttyS0","devices":[{"disk":{"path":"rootfs.img","ro":true}}]}`
	writeFile(t, filepath.Join(dir, "hull.json"), manifest)

	h1, err := loadHull(dir)
	if err != nil {
		t.Fatalf("loadHull: %v", err)
	}
	writeFile(t, filepath.Join(dir, "rootfs.img"), "different-rootfs-bytes")
	h2, err := loadHull(dir)
	if err != nil {
		t.Fatalf("loadHull: %v", err)
	}
	if h1.digest == h2.digest {
		t.Fatal("digest did not change when disk content changed")
	}
}

func TestLoadHullRejectsMalformedDevices(t *testing.T) {
	for name, devices := range map[string]string{
		"neither":      `[{}]`,
		"both":         `[{"share":{"tag":"t","host":"/h"},"disk":{"path":"d.img"}}]`,
		"missing path": `[{"disk":{"ro":true}}]`,
	} {
		dir := t.TempDir()
		writeFile(t, filepath.Join(dir, "vmlinux"), "kernel-bytes")
		writeFile(t, filepath.Join(dir, "initrd"), "initrd-bytes")
		writeFile(t, filepath.Join(dir, "hull.json"),
			`{"kernel":"vmlinux","initrd":"initrd","cmdline":"console=ttyS0","devices":`+devices+`}`)
		if _, err := loadHull(dir); err == nil {
			t.Fatalf("%s: expected error", name)
		}
	}
}

func TestLoadHullRequiresFields(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "hull.json"), `{"kernel":"vmlinux"}`)
	if _, err := loadHull(dir); err == nil {
		t.Fatal("expected error for missing initrd/cmdline")
	}
}

func TestLoadHullMissingFile(t *testing.T) {
	if _, err := loadHull(t.TempDir()); err == nil {
		t.Fatal("expected error for missing hull.json")
	}
}

// The guest's half of the contract, read straight off a directory: a status
// file it wrote, or the absence of one because it never finished.
func TestReadBuildResult(t *testing.T) {
	tests := []struct {
		name       string
		status     string // written to result/status; "" writes no file at all
		exitReason string
		wantStatus string
		wantDetail string
	}{
		{
			name:       "the guest wrote SUCCEEDED",
			status:     "SUCCEEDED\n",
			wantStatus: buildSucceeded,
		},
		{
			name:       "no status file and the guest halted itself",
			exitReason: "",
			wantStatus: buildFailed,
			wantDetail: "skiff exited without writing a result",
		},
		{
			name:       "no status file because bosun killed the skiff, which the detail names",
			exitReason: exitLifetime,
			wantStatus: buildFailed,
			wantDetail: "skiff exited without writing a result (lifetime)",
		},
		{
			name:       "a status bosun does not recognize is a failure, not a passthrough",
			status:     "MAYBE",
			wantStatus: buildFailed,
			wantDetail: `unrecognized result status "MAYBE"`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			diagDir := t.TempDir()
			resultDir := filepath.Join(diagDir, "result")
			if err := os.MkdirAll(resultDir, 0o755); err != nil {
				t.Fatal(err)
			}
			writeFile(t, filepath.Join(resultDir, "build.log"), "build output\n")
			if tt.status != "" {
				writeFile(t, filepath.Join(resultDir, "status"), tt.status)
			}

			got := readBuildResult(diagDir, tt.exitReason, testLogger())
			if got.Status != tt.wantStatus {
				t.Errorf("status = %q, want %q", got.Status, tt.wantStatus)
			}
			if got.Detail != tt.wantDetail {
				t.Errorf("detail = %q, want %q", got.Detail, tt.wantDetail)
			}
			// The log always comes back, whatever the status: it is the only
			// evidence of a build that never wrote one.
			if got.Log != "build output\n" {
				t.Errorf("log = %q, want the guest's build.log", got.Log)
			}
		})
	}
}

func TestLoadHullRejectsMoreDisksThanGuestDeviceNames(t *testing.T) {
	dir := t.TempDir()
	devices := make([]hullDevice, maxHullDisks+1)
	for i := range devices {
		devices[i] = hullDevice{Disk: &hullDisk{Path: "rootfs.img"}}
	}
	hullDir := writeTestHull(t, dir, "toomany", devices)
	writeFile(t, filepath.Join(hullDir, "rootfs.img"), "rootfs-bytes")
	if _, err := loadHull(hullDir); err == nil {
		t.Fatal("expected an error for a hull declaring more disks than there are device names")
	}
}
