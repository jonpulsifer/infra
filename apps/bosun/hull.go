package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
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
	disks := 0
	for i, dev := range m.Devices {
		switch {
		case dev.Share != nil && dev.Disk == nil:
		case dev.Disk != nil && dev.Share == nil:
			if dev.Disk.Path == "" {
				return nil, fmt.Errorf("hull manifest %s: devices[%d].disk.path is required", dir, i)
			}
			shipped = append(shipped, dev.Disk.Path)
			disks++
		default:
			return nil, fmt.Errorf("hull manifest %s: devices[%d] must declare exactly one of share or disk", dir, i)
		}
	}
	// Guest disk names run /dev/vda..vdz, and bosun may append a workspace
	// disk after whatever the hull declared. Past this the name it puts on the
	// cmdline would be wrong rather than missing, so the manifest is rejected.
	if disks > maxHullDisks {
		return nil, fmt.Errorf("hull manifest %s: %d disks exceeds the %d guest device names available", dir, disks, maxHullDisks)
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

// maxHullDisks leaves one of the 26 /dev/vd? names for bosun's workspace
// disk, which is always appended last.
const maxHullDisks = 25

// guestDiskName is the device cloud-hypervisor presents for the nth --disk,
// in declaration order. bosun tells the guest this name rather than letting
// it count, because an index shifts with whatever the hull declared while a
// name handed over on the cmdline does not.
func guestDiskName(n int) string {
	return "/dev/vd" + string(rune('a'+n))
}

// readBuildResult is the other half of the bosun<->hull contract hull.json
// declares: what a build skiff's guest leaves behind. The guest writes
// result/status and result/build.log into its diag share -- the one writable
// path it has -- and this reads them back.
//
// diagDir is kept on purpose by retire, the same evidence a wedged GitHub
// skiff leaves behind. A missing status file means the guest never finished
// the handshake, which is reported as FAILED rather than left for Spindrift's
// lease to time out on. exitReason is why bosun ended the skiff, empty when
// the guest halted itself; logger carries only the two warnings for a guest
// that did not hold up its end.
func readBuildResult(diagDir, exitReason string, logger *slog.Logger) buildResult {
	logBytes, _ := os.ReadFile(filepath.Join(diagDir, "result", "build.log"))
	logText := tailString(logBytes, buildResultMaxLog)

	statusRaw, err := os.ReadFile(filepath.Join(diagDir, "result", "status"))
	if err != nil {
		detail := "skiff exited without writing a result"
		if exitReason != "" && exitReason != exitCompleted {
			detail = fmt.Sprintf("skiff exited without writing a result (%s)", exitReason)
		}
		logger.Warn("build result missing", "error", err, "exit_reason", exitReason)
		return buildResult{Status: buildFailed, Log: logText, Detail: detail}
	}

	status := strings.TrimSpace(string(statusRaw))
	if status != buildSucceeded && status != buildFailed {
		logger.Warn("build result status unrecognized", "status", status)
		return buildResult{Status: buildFailed, Log: logText, Detail: fmt.Sprintf("unrecognized result status %q", status)}
	}
	return buildResult{Status: status, Log: logText}
}
