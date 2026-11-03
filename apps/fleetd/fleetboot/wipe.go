package fleetboot

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/jonpulsifer/infra/apps/fleetd/protocol"
)

// probeVariable is the EFI variable the wipe writes and removes to learn
// that the firmware stores variables, under a GUID no firmware uses.
const probeVariable = "FleetWriteProbe-7e1ab0f1-0000-4000-8000-0000000000aa"

const mib = 1 << 20

// wipe wipes the install disk: every partition's signatures and first 16
// MiB, the disk's signatures, both GPTs, the first and last MiB, and for a
// retirement the rest of the disk. A run that installs first proves the
// firmware stores EFI variables, since next-boot writes them after the
// disk is written.
func (e *Executor) wipe(ctx context.Context, r protocol.BootRun) (string, error) {
	if !r.Wipe {
		return "nothing wiped this run", nil
	}
	started := e.now()
	d, err := e.checkDisk(r.Disk, r.DiskSerial, "nothing wiped")
	if err != nil {
		return "", err
	}
	if r.Install {
		if err := e.probeEFIVars(); err != nil {
			return "", err
		}
	}
	parts, err := e.partitions(d)
	if err != nil {
		return "", fmt.Errorf("list %s's partitions: %v; nothing wiped", d.Path, err)
	}
	size, err := diskSize(d.Path)
	if err != nil {
		return "", fmt.Errorf("size %s: %v; nothing wiped", d.Path, err)
	}
	var samples []int64
	if r.Retire {
		samples = planSamples(size, parts)
	}
	e.logf("wiping every partition of %s", d.Path)
	for _, p := range parts {
		dev := filepath.Join(e.Dev, p.Name)
		if out, err := e.Host.Run(ctx, "wipefs", "--all", "--force", dev); err != nil {
			return "", fmt.Errorf("wipefs %s: %v %s", dev, err, strings.TrimSpace(string(out)))
		}
		_ = zeroAt(dev, 0, 16*mib)
	}
	for _, c := range [][]string{{"wipefs", "--all", "--force", d.Path}, {"sgdisk", "--zap-all", d.Path}} {
		if out, err := e.Host.Run(ctx, c[0], c[1:]...); err != nil {
			return "", fmt.Errorf("%s %s: %v %s", c[0], d.Path, err, strings.TrimSpace(string(out)))
		}
	}
	if err := zeroAt(d.Path, 0, mib); err != nil {
		return "", err
	}
	if err := zeroAt(d.Path, size-mib, mib); err != nil {
		return "", err
	}
	if r.Retire {
		deadline := started.Add(e.EraseBudget)
		if err := e.erase(ctx, d, size, samples, deadline); err != nil {
			return "", fmt.Errorf("%s could not be erased (%v); the retirement stops with the disk partly erased", d.Path, err)
		}
	}
	_, _ = e.Host.Run(ctx, "blockdev", "--rereadpt", d.Path)
	// blkid exits 2 when it finds nothing.
	if out, err := e.Host.Run(ctx, "blkid", "-p", d.Path); err == nil {
		return "", fmt.Errorf("%s still has a signature: %s", d.Path, strings.TrimSpace(string(out)))
	}
	e.wiped = true
	return "wiped " + d.Path, nil
}

// zeroAt writes length zero bytes at offset of the device and syncs them.
func zeroAt(path string, offset, length int64) error {
	f, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	zero := make([]byte, mib)
	for done := int64(0); done < length; {
		n := min(int64(len(zero)), length-done)
		if _, err := f.WriteAt(zero[:n], offset+done); err != nil {
			return fmt.Errorf("zero %s at %d: %w", path, offset+done, err)
		}
		done += n
	}
	return f.Sync()
}

// probeEFIVars writes and removes a 1 KiB variable. efivarfs takes a
// variable in one write: its 4-byte attributes, then the data.
func (e *Executor) probeEFIVars() error {
	e.mountEFIVars()
	probe := filepath.Join(e.EFIVars, probeVariable)
	data := append([]byte{7, 0, 0, 0}, make([]byte, 1024)...)
	if err := os.WriteFile(probe, data, 0o644); err != nil {
		_ = os.Remove(probe)
		return fmt.Errorf("the firmware refuses to store EFI variables (%v); nothing wiped", err)
	}
	_ = e.Host.ClearImmutable(probe)
	if err := os.Remove(probe); err != nil {
		return fmt.Errorf("the probe variable %s cannot be removed (%v); nothing wiped", probe, err)
	}
	return nil
}

// mountEFIVars mounts efivarfs where it is missing and makes it writable:
// it has one superblock, so any earlier read-only mount holds for all.
func (e *Executor) mountEFIVars() {
	_ = e.Host.Mount("efivarfs", e.EFIVars, "efivarfs", "")
	_ = e.Host.Remount(e.EFIVars)
}

// remaining is how long is left before deadline, as of now.
func (e *Executor) remaining(deadline time.Time) time.Duration { return deadline.Sub(e.now()) }
