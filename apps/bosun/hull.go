package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// hullManifest is hull.json: the declared shape of a microVM image. bosun
// translates it into cloud-hypervisor argv and carries no branching per hull
// family — it never knows what built the kernel or what a device path means.
type hullManifest struct {
	Kernel  string       `json:"kernel"`
	Initrd  string       `json:"initrd"`
	Cmdline string       `json:"cmdline"`
	Devices []hullDevice `json:"devices,omitempty"`
}

// hullDevice is one declared guest device: exactly one of its fields is set.
// A share is a virtiofs directory bosun runs a virtiofsd for; a disk is a
// file the hull ships, handed to the guest as a virtio-blk device.
type hullDevice struct {
	Share *hullShare `json:"share,omitempty"`
	Disk  *hullDisk  `json:"disk,omitempty"`
}

type hullShare struct {
	Tag  string `json:"tag"`
	Host string `json:"host"`
	RO   bool   `json:"ro"`
}

type hullDisk struct {
	Path string `json:"path"` // relative to the hull directory, like kernel and initrd
	RO   bool   `json:"ro"`
}

// hull is a loaded manifest plus the digest bosun computed for it. id is
// deliberately absent from hull.json — a digest cannot live inside the file
// it digests — so bosun computes it here: sha256 over hull.json's bytes plus
// the kernel and initrd files it names, then each disk in declaration order.
// Device share hosts are not hashed: they are host-side bind targets (e.g.
// /nix/store), not content the hull ships. Disks are hashed: a rootfs image
// is exactly the content a hull ships.
type hull struct {
	dir      string
	manifest hullManifest
	digest   string // hex sha256, no "sha256:" prefix
}

func loadHull(dir string) (*hull, error) {
	raw, err := os.ReadFile(filepath.Join(dir, "hull.json"))
	if err != nil {
		return nil, fmt.Errorf("reading hull manifest: %w", err)
	}
	var m hullManifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("parsing hull manifest: %w", err)
	}
	if m.Kernel == "" || m.Initrd == "" || m.Cmdline == "" {
		return nil, fmt.Errorf("hull manifest %s: kernel, initrd, and cmdline are required", dir)
	}

	shipped := []string{m.Kernel, m.Initrd}
	for i, dev := range m.Devices {
		switch {
		case dev.Share != nil && dev.Disk == nil:
		case dev.Disk != nil && dev.Share == nil:
			if dev.Disk.Path == "" {
				return nil, fmt.Errorf("hull manifest %s: devices[%d].disk.path is required", dir, i)
			}
			shipped = append(shipped, dev.Disk.Path)
		default:
			return nil, fmt.Errorf("hull manifest %s: devices[%d] must declare exactly one of share or disk", dir, i)
		}
	}

	// ponytail: hashes every shipped file (a rootfs disk is GBs) on each
	// spawn; cache by (path, mtime) if refill latency ever matters.
	h := sha256.New()
	h.Write(raw)
	for _, name := range shipped {
		if err := hashFile(h, filepath.Join(dir, name)); err != nil {
			return nil, fmt.Errorf("hashing hull file %s: %w", name, err)
		}
	}

	return &hull{dir: dir, manifest: m, digest: hex.EncodeToString(h.Sum(nil))}, nil
}

func hashFile(w io.Writer, path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(w, f)
	return err
}

// maxSockPathLen is Linux's sockaddr_un.sun_path capacity minus its NUL
// terminator (108 bytes total). A longer path truncates silently and the
// VMM that tries to connect never starts.
const maxSockPathLen = 107

func sockPath(dir, name string) (string, error) {
	p := filepath.Join(dir, name)
	if len(p) > maxSockPathLen {
		return "", fmt.Errorf("socket path exceeds %d bytes (AF_UNIX limit): %s", maxSockPathLen, p)
	}
	return p, nil
}

// skiffPaths are every filesystem and socket path bosun uses for one skiff,
// computed once so the cloud-hypervisor argv and the virtiofsd/passt
// processes it depends on always agree, and so the SUN_LEN check happens in
// exactly one place.
type skiffPaths struct {
	dir         string   // runtimeDir/<id> — the credential share and bosun's entire state for this skiff
	credSock    string   // runtimeDir/<id>.fs
	netSock     string   // runtimeDir/<id>.net
	apiSock     string   // runtimeDir/<id>.api
	logFile     string   // logDir/<id>.log — the guest's serial console, via cloud-hypervisor's --serial
	deviceSocks []string // parallel to the hull manifest's Devices
}

func resolvePaths(runtimeDir, logDir, id string, devices []hullDevice) (skiffPaths, error) {
	var p skiffPaths
	var err error
	p.dir = filepath.Join(runtimeDir, id)
	p.logFile = filepath.Join(logDir, id+".log")
	if p.credSock, err = sockPath(runtimeDir, id+".fs"); err != nil {
		return skiffPaths{}, err
	}
	if p.netSock, err = sockPath(runtimeDir, id+".net"); err != nil {
		return skiffPaths{}, err
	}
	if p.apiSock, err = sockPath(runtimeDir, id+".api"); err != nil {
		return skiffPaths{}, err
	}
	// Parallel to devices; a disk needs no helper daemon, so its slot stays
	// empty.
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

// chArgs builds cloud-hypervisor's argv for one skiff. The credential share
// (tag "bosun") is injected unconditionally ahead of any hull-declared
// devices; its tag is fixed by contract with the guest-side agent, and it is
// present even when the hull declares no devices at all.
func chArgs(h *hull, class Class, id string, p skiffPaths) []string {
	args := []string{
		"--kernel", filepath.Join(h.dir, h.manifest.Kernel),
		"--initramfs", filepath.Join(h.dir, h.manifest.Initrd),
		"--cpus", fmt.Sprintf("boot=%d", class.VCPUs),
		"--memory", fmt.Sprintf("size=%s,shared=on", class.Memory),
		"--fs", fmt.Sprintf("tag=bosun,socket=%s", p.credSock),
	}
	for i, dev := range h.manifest.Devices {
		switch {
		case dev.Share != nil:
			args = append(args, "--fs", fmt.Sprintf("tag=%s,socket=%s", dev.Share.Tag, p.deviceSocks[i]))
		case dev.Disk != nil:
			ro := "off"
			if dev.Disk.RO {
				ro = "on"
			}
			args = append(args, "--disk", fmt.Sprintf("path=%s,readonly=%s", filepath.Join(h.dir, dev.Disk.Path), ro))
		}
	}
	args = append(args,
		"--net", fmt.Sprintf("vhost_user=on,socket=%s", p.netSock),
		"--api-socket", p.apiSock,
		"--console", "off",
		"--serial", fmt.Sprintf("file=%s", p.logFile),
		"--cmdline", fmt.Sprintf("%s bosun.skiff=%s bosun.hull=sha256:%s", h.manifest.Cmdline, id, h.digest),
	)
	return args
}

// virtiofsdArgs builds one virtiofsd instance's argv, shared by the
// credential share and every hull-declared device share.
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

func passtArgs(sock string) []string {
	return []string{
		"--vhost-user",
		"-s", sock,
		"--map-host-loopback", "none",
		"--map-guest-addr", "none",
		"-4",
		"-D", "1.1.1.1",
	}
}
