package main

import (
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
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

	got := chArgs(h, class, "sk01", paths, "")
	want := []string{
		"--kernel", "/hulls/nixos/vmlinux",
		"--initramfs", "/hulls/nixos/initrd",
		"--cpus", "boot=4",
		"--memory", "size=4096M,shared=on",
		"--fs", "tag=bosun,socket=/run/bosun/sk01.fs",
		"--fs", "tag=bosun-diag,socket=/run/bosun/sk01.diag.fs",
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

	got := chArgs(h, class, "sk02", paths, "")
	want := []string{
		"--kernel", "/hulls/nixos/vmlinux",
		"--initramfs", "/hulls/nixos/initrd",
		"--cpus", "boot=2",
		"--memory", "size=2048M,shared=on",
		"--fs", "tag=bosun,socket=/run/bosun/sk02.fs",
		"--fs", "tag=bosun-diag,socket=/run/bosun/sk02.diag.fs",
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

	got := chArgs(h, class, "sk03", paths, "")
	want := []string{
		"--kernel", "/hulls/ubuntu/vmlinux",
		"--initramfs", "/hulls/ubuntu/initrd",
		"--cpus", "boot=2",
		"--memory", "size=2048M,shared=on",
		"--fs", "tag=bosun,socket=/run/bosun/sk03.fs",
		"--fs", "tag=bosun-diag,socket=/run/bosun/sk03.diag.fs",
		"--disk", "path=/hulls/ubuntu/rootfs.img,readonly=on,image_type=raw",
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

func TestResolvePathsPutsDiagUnderLogDir(t *testing.T) {
	p, err := resolvePaths("/run/bosun", "/var/log/bosun", "sk01", nil)
	if err != nil {
		t.Fatalf("resolvePaths: %v", err)
	}
	if p.diagDir != "/var/log/bosun/sk01.diag" {
		t.Errorf("diagDir: got %s", p.diagDir)
	}
	if p.diagSock != "/run/bosun/sk01.diag.fs" {
		t.Errorf("diagSock: got %s", p.diagSock)
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

// The workspace disk goes after the hull's own disks so their indices are
// untouched, and the guest is told the name rather than left to count.
func TestChArgsWorkspaceDiskComesLastAndIsNamedOnTheCmdline(t *testing.T) {
	h := &hull{
		dir: "/hulls/ubuntu",
		manifest: hullManifest{
			Kernel: "vmlinux", Initrd: "initrd", Cmdline: "console=ttyS0",
			Devices: []hullDevice{{Disk: &hullDisk{Path: "rootfs.img", RO: true}}},
		},
		digest: "deadbeef",
	}
	class := Class{VCPUs: 4, Memory: "3072M", Workspace: "6G"}
	paths, err := resolvePaths("/run/bosun", "/var/log/bosun", "sk09", h.manifest.Devices)
	if err != nil {
		t.Fatalf("resolvePaths: %v", err)
	}
	paths.workspace = "/var/lib/bosun/workspace/sk09.img"

	got := chArgs(h, class, "sk09", paths, "")
	want := []string{
		"--kernel", "/hulls/ubuntu/vmlinux",
		"--initramfs", "/hulls/ubuntu/initrd",
		"--cpus", "boot=4",
		"--memory", "size=3072M,shared=on",
		"--fs", "tag=bosun,socket=/run/bosun/sk09.fs",
		"--fs", "tag=bosun-diag,socket=/run/bosun/sk09.diag.fs",
		"--disk", "path=/hulls/ubuntu/rootfs.img,readonly=on,image_type=raw",
		"--disk", "path=/var/lib/bosun/workspace/sk09.img,readonly=off,image_type=raw",
		"--net", "vhost_user=on,socket=/run/bosun/sk09.net",
		"--api-socket", "/run/bosun/sk09.api",
		"--console", "off",
		"--serial", "file=/var/log/bosun/sk09.log",
		// vdb, not vda: the hull's rootfs holds vda.
		"--cmdline", "console=ttyS0 bosun.workspace=/dev/vdb bosun.skiff=sk09 bosun.hull=sha256:deadbeef",
	}
	if !slices.Equal(got, want) {
		t.Fatalf("argv mismatch:\n got:  %v\n want: %v", got, want)
	}
}

// A class with no workspace must produce exactly the argv it produced before
// the option existed: no disk, and nothing extra on the cmdline.
func TestChArgsNoWorkspaceLeavesCmdlineAlone(t *testing.T) {
	h := &hull{
		dir:      "/hulls/nixos",
		manifest: hullManifest{Kernel: "vmlinux", Initrd: "initrd", Cmdline: "console=ttyS0"},
		digest:   "deadbeef",
	}
	paths, err := resolvePaths("/run/bosun", "/var/log/bosun", "sk10", nil)
	if err != nil {
		t.Fatalf("resolvePaths: %v", err)
	}
	got := chArgs(h, Class{VCPUs: 1, Memory: "512M"}, "sk10", paths, "")
	if slices.Contains(got, "--disk") {
		t.Fatalf("workspace-less class got a disk: %v", got)
	}
	if !slices.Contains(got, "console=ttyS0 bosun.skiff=sk10 bosun.hull=sha256:deadbeef") {
		t.Fatalf("cmdline changed: %v", got)
	}
}

func TestChArgsAnnouncesCacheURLOnCmdline(t *testing.T) {
	h := &hull{
		dir:      "/hulls/nixos",
		manifest: hullManifest{Kernel: "vmlinux", Initrd: "initrd", Cmdline: "console=ttyS0"},
		digest:   "deadbeef",
	}
	paths, err := resolvePaths("/run/bosun", "/var/log/bosun", "sk12", nil)
	if err != nil {
		t.Fatalf("resolvePaths: %v", err)
	}
	got := chArgs(h, Class{VCPUs: 1, Memory: "512M"}, "sk12", paths, "http://10.113.113.1:3000/")
	if !slices.Contains(got, "console=ttyS0 bosun.cache=http://10.113.113.1:3000/ bosun.skiff=sk12 bosun.hull=sha256:deadbeef") {
		t.Fatalf("cache URL missing from cmdline: %v", got)
	}
}

// The reservation is the whole reason the disk exists: a sparse file would
// move the overcommit onto the host filesystem rather than remove it.
func TestEnsureWorkspaceReservesTheWholeSize(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "sk11.img")
	if err := ensureWorkspace(path, "2M", false); err != nil {
		t.Fatalf("ensureWorkspace: %v", err)
	}
	var st syscall.Stat_t
	if err := syscall.Stat(path, &st); err != nil {
		t.Fatalf("stat: %v", err)
	}
	if st.Size != 2<<20 {
		t.Errorf("size = %d, want %d", st.Size, 2<<20)
	}
	// 512-byte blocks: a sparse file of this size reports far fewer.
	if want := int64(2 << 20 / 512); st.Blocks < want {
		t.Errorf("allocated %d blocks, want at least %d -- the file is sparse", st.Blocks, want)
	}

	if err := ensureWorkspace(path, "nonsense", false); err == nil {
		t.Fatal("expected an error for an unparseable size")
	}
}

// The whole value of a persisting class is that the next skiff finds what the
// last one left, so an image the right size must survive being ensured again --
// and the ephemeral path must still truncate, or a class that stopped
// persisting would quietly keep handing out the old disk.
func TestEnsureWorkspaceKeepsAPersistedImageAndTruncatesAnEphemeralOne(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "skiff-ubuntu-0.img")
	if err := ensureWorkspace(path, "2M", true); err != nil {
		t.Fatalf("ensureWorkspace: %v", err)
	}
	// Stands in for a filesystem and its caches: bosun never learns what is on
	// the disk, only whether it left it alone.
	if err := os.WriteFile(path, append([]byte("warm-cache"), make([]byte, 2<<20-10)...), 0o600); err != nil {
		t.Fatalf("seed image: %v", err)
	}

	if err := ensureWorkspace(path, "2M", true); err != nil {
		t.Fatalf("ensureWorkspace (keep): %v", err)
	}
	kept, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(kept[:10]) != "warm-cache" {
		t.Errorf("persisted image was rewritten: got %q", kept[:10])
	}

	// A class whose workspace size changed cannot keep a filesystem sized for
	// the old figure.
	if err := ensureWorkspace(path, "3M", true); err != nil {
		t.Fatalf("ensureWorkspace (resize): %v", err)
	}
	resized, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(resized) != 3<<20 {
		t.Errorf("size = %d, want %d", len(resized), 3<<20)
	}
	if string(resized[:10]) == "warm-cache" {
		t.Error("a resized image kept the old filesystem")
	}

	if err := ensureWorkspace(path, "3M", false); err != nil {
		t.Fatalf("ensureWorkspace (ephemeral): %v", err)
	}
	fresh, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	for i, b := range fresh {
		if b != 0 {
			t.Fatalf("ephemeral image not truncated: byte %d = %#x", i, b)
		}
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
