package main

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// The VMM side of a skiff: its paths and sockets, the argv bosun builds from a
// hull, and its workspace disk.

// sun_path holds 108 bytes including the NUL. A longer path truncates silently
// and the VMM never starts.
const maxSockPathLen = 107

func sockPath(dir, name string) (string, error) {
	p := filepath.Join(dir, name)
	if len(p) > maxSockPathLen {
		return "", fmt.Errorf("socket path exceeds %d bytes (AF_UNIX limit): %s", maxSockPathLen, p)
	}
	return p, nil
}

// Computed once, so the argv and the helpers agree and one place checks SUN_LEN.
type skiffPaths struct {
	dir         string   // runtimeDir/<id> — the credential share and bosun's state for this skiff
	workspace   string   // workspaceDir/<id>.img or a persisting slot's image; empty if none
	credSock    string   // runtimeDir/<id>.fs
	diagDir     string   // logDir/<id>.diag — the guest's runner _diag, written through to the host
	diagSock    string   // runtimeDir/<id>.diag.fs
	netSock     string   // runtimeDir/<id>.net
	apiSock     string   // runtimeDir/<id>.api
	logFile     string   // logDir/<id>.log — the guest's serial console, via cloud-hypervisor's --serial
	deviceSocks []string // parallel to the hull manifest's Devices
}

// Teardown iterates this, so a socket added to skiffPaths is never leaked.
func (p skiffPaths) sockets() []string {
	socks := []string{p.credSock, p.diagSock, p.netSock, p.apiSock}
	for _, sock := range p.deviceSocks {
		if sock != "" {
			socks = append(socks, sock)
		}
	}
	return socks
}

func resolvePaths(runtimeDir, logDir, id string, devices []hullDevice) (skiffPaths, error) {
	var p skiffPaths
	var err error
	p.dir = filepath.Join(runtimeDir, id)
	p.logFile = filepath.Join(logDir, id+".log")
	// Under logDir, not runtimeDir: this is the one thing about a skiff that
	// must outlive it, and runtimeDir is tmpfs that retire empties anyway.
	p.diagDir = filepath.Join(logDir, id+".diag")
	if p.credSock, err = sockPath(runtimeDir, id+".fs"); err != nil {
		return skiffPaths{}, err
	}
	if p.diagSock, err = sockPath(runtimeDir, id+".diag.fs"); err != nil {
		return skiffPaths{}, err
	}
	if p.netSock, err = sockPath(runtimeDir, id+".net"); err != nil {
		return skiffPaths{}, err
	}
	if p.apiSock, err = sockPath(runtimeDir, id+".api"); err != nil {
		return skiffPaths{}, err
	}
	// Parallel to devices; a disk has no helper, so its slot stays empty.
	p.deviceSocks = make([]string, len(devices))
	for i, dev := range devices {
		if dev.Share == nil {
			continue
		}
		if p.deviceSocks[i], err = sockPath(runtimeDir, id+"."+dev.Share.Tag+".fs"); err != nil {
			return skiffPaths{}, err
		}
	}
	return p, nil
}

// Host-local endpoints announced on the cmdline; an empty field adds no token.
type hostServices struct {
	cacheURL    string
	buildkitURL string
}

// chArgs puts the "bosun" credential share (read-only in-guest) and the
// writable "bosun-diag" share first; the guest expects both tags.
func chArgs(h *hull, class Class, id string, p skiffPaths, svc hostServices, build bool) []string {
	args := []string{
		"--kernel", filepath.Join(h.dir, h.manifest.Kernel),
		"--initramfs", filepath.Join(h.dir, h.manifest.Initrd),
		"--cpus", fmt.Sprintf("boot=%d", class.VCPUs),
		"--memory", fmt.Sprintf("size=%s,shared=on", class.Memory),
		"--fs", fmt.Sprintf("tag=bosun,socket=%s", p.credSock),
		"--fs", fmt.Sprintf("tag=bosun-diag,socket=%s", p.diagSock),
	}
	disks := 0
	for i, dev := range h.manifest.Devices {
		switch {
		case dev.Share != nil:
			args = append(args, "--fs", fmt.Sprintf("tag=%s,socket=%s", dev.Share.Tag, p.deviceSocks[i]))
		case dev.Disk != nil:
			ro := "off"
			if dev.Disk.RO {
				ro = "on"
			}
			// image_type=raw: cloud-hypervisor 52 disables sector-0 writes on a
			// disk whose type it auto-detects, so the guest's mkfs fails.
			args = append(args, "--disk", fmt.Sprintf("path=%s,readonly=%s,image_type=raw", filepath.Join(h.dir, dev.Disk.Path), ro))
			disks++
		}
	}
	cmdline := h.manifest.Cmdline
	// After every hull disk, so the hull's disk indices hold.
	if p.workspace != "" {
		args = append(args, "--disk", fmt.Sprintf("path=%s,readonly=off,image_type=raw", p.workspace))
		cmdline += " bosun.workspace=" + guestDiskName(disks)
	}
	// Endpoints an admin configured; the hull decides whether to use them.
	if svc.cacheURL != "" {
		cmdline += " bosun.cache=" + svc.cacheURL
	}
	if svc.buildkitURL != "" {
		cmdline += " bosun.buildkit=" + svc.buildkitURL
	}
	// The guest then reads request.json from the bosun share, not jitconfig.
	if build {
		cmdline += " bosun.mode=build"
	}
	args = append(args,
		"--net", fmt.Sprintf("vhost_user=on,socket=%s", p.netSock),
		"--api-socket", p.apiSock,
		"--console", "off",
		"--serial", fmt.Sprintf("file=%s", p.logFile),
		"--cmdline", fmt.Sprintf("%s bosun.skiff=%s bosun.hull=sha256:%s", cmdline, id, h.digest),
	)
	return args
}

// ensureWorkspace fallocates the disk: a sparse file would move the memory
// overcommit onto the host filesystem, and a full host should fail a spawn.
func ensureWorkspace(path, size string, keep bool) error {
	n, err := parseSize(size)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	// keep reuses a persisting slot's image while its size still matches;
	// otherwise the disk is recreated empty.
	if keep {
		if info, err := os.Stat(path); err == nil && info.Size() == n {
			return nil
		}
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	return syscall.Fallocate(int(f.Fd()), 0, 0, n)
}

func virtiofsdArgs(sock, sharedDir string, ro bool) []string {
	args := []string{
		"--socket-path=" + sock,
		"--shared-dir=" + sharedDir,
		"--sandbox", "namespace", // unprivileged; --sandbox chroot requires root
		"--cache", "auto",
	}
	if ro {
		args = append(args, "--readonly")
	}
	return args
}

// --foreground keeps passt a child so Kill() reaches it; --one-off exits when
// the VMM disconnects instead of spinning for a second client.
func passtArgs(sock string) []string {
	return []string{
		"--vhost-user",
		"--foreground",
		"--one-off",
		"-s", sock,
		"--map-host-loopback", "none",
		"--map-guest-addr", "none",
		"-4",
		"-D", "1.1.1.1",
	}
}
