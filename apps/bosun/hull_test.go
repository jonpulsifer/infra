package main

import (
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
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

func TestChArgsNoDevices(t *testing.T) {
	h := &hull{
		dir:      "/hulls/nixos",
		manifest: hullManifest{Kernel: "vmlinux", Initrd: "initrd", Cmdline: "console=ttyS0"},
		digest:   "deadbeef",
	}
	class := Class{VCPUs: 4, Memory: "4096M"}
	paths, err := resolvePaths("/run/bosun", "/var/log/bosun", "sk01", h.manifest.Devices)
	if err != nil {
		t.Fatalf("resolvePaths: %v", err)
	}

	got := chArgs(h, class, "sk01", paths)
	want := []string{
		"--kernel", "/hulls/nixos/vmlinux",
		"--initramfs", "/hulls/nixos/initrd",
		"--cpus", "boot=4",
		"--memory", "size=4096M,shared=on",
		"--fs", "tag=bosun,socket=/run/bosun/sk01.fs",
		"--net", "vhost_user=on,socket=/run/bosun/sk01.net",
		"--api-socket", "/run/bosun/sk01.api",
		"--console", "off",
		"--serial", "file=/var/log/bosun/sk01.log",
		"--cmdline", "console=ttyS0 bosun.skiff=sk01 bosun.hull=sha256:deadbeef",
	}
	if !slices.Equal(got, want) {
		t.Fatalf("argv mismatch:\n got:  %v\n want: %v", got, want)
	}
}

func TestChArgsWithDevices(t *testing.T) {
	h := &hull{
		dir: "/hulls/nixos",
		manifest: hullManifest{
			Kernel: "vmlinux", Initrd: "initrd", Cmdline: "console=ttyS0",
			Devices: []hullDevice{{Share: &hullShare{Tag: "ro-store", Host: "/nix/store", RO: true}}},
		},
		digest: "deadbeef",
	}
	class := Class{VCPUs: 2, Memory: "2048M"}
	paths, err := resolvePaths("/run/bosun", "/var/log/bosun", "sk02", h.manifest.Devices)
	if err != nil {
		t.Fatalf("resolvePaths: %v", err)
	}

	got := chArgs(h, class, "sk02", paths)
	want := []string{
		"--kernel", "/hulls/nixos/vmlinux",
		"--initramfs", "/hulls/nixos/initrd",
		"--cpus", "boot=2",
		"--memory", "size=2048M,shared=on",
		"--fs", "tag=bosun,socket=/run/bosun/sk02.fs",
		"--fs", "tag=ro-store,socket=/run/bosun/sk02.ro-store.fs",
		"--net", "vhost_user=on,socket=/run/bosun/sk02.net",
		"--api-socket", "/run/bosun/sk02.api",
		"--console", "off",
		"--serial", "file=/var/log/bosun/sk02.log",
		"--cmdline", "console=ttyS0 bosun.skiff=sk02 bosun.hull=sha256:deadbeef",
	}
	if !slices.Equal(got, want) {
		t.Fatalf("argv mismatch:\n got:  %v\n want: %v", got, want)
	}
}

func TestChArgsWithDisk(t *testing.T) {
	h := &hull{
		dir: "/hulls/ubuntu",
		manifest: hullManifest{
			Kernel: "vmlinux", Initrd: "initrd", Cmdline: "console=ttyS0",
			Devices: []hullDevice{{Disk: &hullDisk{Path: "rootfs.img", RO: true}}},
		},
		digest: "deadbeef",
	}
	class := Class{VCPUs: 2, Memory: "2048M"}
	paths, err := resolvePaths("/run/bosun", "/var/log/bosun", "sk03", h.manifest.Devices)
	if err != nil {
		t.Fatalf("resolvePaths: %v", err)
	}

	got := chArgs(h, class, "sk03", paths)
	want := []string{
		"--kernel", "/hulls/ubuntu/vmlinux",
		"--initramfs", "/hulls/ubuntu/initrd",
		"--cpus", "boot=2",
		"--memory", "size=2048M,shared=on",
		"--fs", "tag=bosun,socket=/run/bosun/sk03.fs",
		"--disk", "path=/hulls/ubuntu/rootfs.img,readonly=on",
		"--net", "vhost_user=on,socket=/run/bosun/sk03.net",
		"--api-socket", "/run/bosun/sk03.api",
		"--console", "off",
		"--serial", "file=/var/log/bosun/sk03.log",
		"--cmdline", "console=ttyS0 bosun.skiff=sk03 bosun.hull=sha256:deadbeef",
	}
	if !slices.Equal(got, want) {
		t.Fatalf("argv mismatch:\n got:  %v\n want: %v", got, want)
	}
}

func TestVirtiofsdArgs(t *testing.T) {
	got := virtiofsdArgs("/run/bosun/sk01.fs", "/run/bosun/sk01", false)
	want := []string{"--socket-path=/run/bosun/sk01.fs", "--shared-dir=/run/bosun/sk01", "--sandbox", "namespace", "--cache", "auto"}
	if !slices.Equal(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}

	got = virtiofsdArgs("/run/bosun/sk01.ro-store.fs", "/nix/store", true)
	want = []string{"--socket-path=/run/bosun/sk01.ro-store.fs", "--shared-dir=/nix/store", "--sandbox", "namespace", "--cache", "auto", "--readonly"}
	if !slices.Equal(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestPasstArgs(t *testing.T) {
	got := passtArgs("/run/bosun/sk01.net")
	want := []string{"--vhost-user", "--foreground", "--one-off", "-s", "/run/bosun/sk01.net", "--map-host-loopback", "none", "--map-guest-addr", "none", "-4", "-D", "1.1.1.1"}
	if !slices.Equal(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestSockPathTooLong(t *testing.T) {
	longDir := "/run/bosun/" + strings.Repeat("x", 120)
	if _, err := sockPath(longDir, "sk01.fs"); err == nil {
		t.Fatal("expected error for over-length socket path")
	}
	if _, err := sockPath("/run/bosun", "sk01.fs"); err != nil {
		t.Fatalf("unexpected error for short path: %v", err)
	}
}

func TestResolvePathsPropagatesSockPathError(t *testing.T) {
	longDir := "/run/bosun/" + strings.Repeat("x", 120)
	if _, err := resolvePaths(longDir, "/var/log/bosun", "sk01", nil); err == nil {
		t.Fatal("expected error")
	}
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
