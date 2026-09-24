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

// hull.json, turned into cloud-hypervisor argv with no per-family branching.
type hullManifest struct {
	Kernel  string       `json:"kernel"`
	Initrd  string       `json:"initrd"`
	Cmdline string       `json:"cmdline"`
	Devices []hullDevice `json:"devices,omitempty"`
}

// Exactly one field is set. A share gets its own virtiofsd; a disk is a file the
// hull ships, attached as virtio-blk.
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

// digest is sha256 over hull.json, the kernel, the initrd and each disk in
// order. Share hosts are host paths such as /nix/store, so they are not hashed.
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
	// A disk past vdz would get a wrong name on the cmdline, so reject it here.
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

// Leaves one of the 26 /dev/vd? names for the workspace disk bosun appends last.
const maxHullDisks = 25

// guestDiskName is the device cloud-hypervisor presents for the nth --disk. bosun
// passes it on the cmdline, since a guest-side index shifts with the hull's disks.
func guestDiskName(n int) string {
	return "/dev/vd" + string(rune('a'+n))
}

// readBuildResult reads the result/ files a build guest writes to its diag
// share. A missing status is FAILED; exitReason is empty if the guest halted.
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
