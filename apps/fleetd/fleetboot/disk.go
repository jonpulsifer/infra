package fleetboot

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

var serialPattern = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

// serialOf is the serial a whole disk under /sys/block reports: an NVMe or
// MMC controller's, a virtio disk's, or a SCSI or SATA disk's unit serial
// number page past its 4-byte header, with blanks and NULs dropped.
func serialOf(dir string) string {
	var b []byte
	var err error
	if b, err = os.ReadFile(filepath.Join(dir, "device/serial")); err != nil {
		if b, err = os.ReadFile(filepath.Join(dir, "serial")); err != nil {
			if b, err = os.ReadFile(filepath.Join(dir, "device/vpd_pg80")); err != nil || len(b) < 4 {
				return ""
			}
			b = b[4:]
		}
	}
	return strings.Map(func(r rune) rune {
		switch r {
		case ' ', '\t', '\n', 0:
			return -1
		}
		return r
	}, string(b))
}

// Disk is the install disk once checkDisk accepts it: its device path, its
// kernel name and its logical sector size.
type Disk struct {
	Path       string
	Name       string
	SectorSize int
}

// checkDisk accepts the disk at path only when it is a whole block disk
// that reports serial, no other disk reports serial, and it is neither
// removable nor on USB, the Templates' check word for word. why ends each
// refusal, such as "nothing wiped".
func (e *Executor) checkDisk(path, serial, why string) (Disk, error) {
	switch {
	case serial == "":
		return Disk{}, fmt.Errorf("no install disk serial is declared for %s; %s", path, why)
	case !serialPattern.MatchString(serial):
		return Disk{}, fmt.Errorf("the install disk serial %s is malformed; %s", serial, why)
	}
	if !e.Host.IsBlockDevice(path) {
		return Disk{}, fmt.Errorf("%s is not a block device; %s", path, why)
	}
	real, err := filepath.EvalSymlinks(path)
	if err != nil {
		return Disk{}, fmt.Errorf("%s does not resolve: %v; %s", path, err, why)
	}
	name := filepath.Base(real)
	block := filepath.Join(e.Sys, "block")
	if fi, err := os.Stat(filepath.Join(block, name)); err != nil || !fi.IsDir() {
		return Disk{}, fmt.Errorf("%s is not a whole disk; %s", path, why)
	}
	entries, err := os.ReadDir(block)
	if err != nil {
		return Disk{}, fmt.Errorf("read %s: %v; %s", block, err, why)
	}
	var found []string
	for _, b := range entries {
		if serialOf(filepath.Join(block, b.Name())) == serial {
			found = append(found, b.Name())
		}
	}
	switch {
	case len(found) == 0:
		return Disk{}, fmt.Errorf("no disk reports the serial %s; %s", serial, why)
	case len(found) > 1:
		return Disk{}, fmt.Errorf("more than one disk reports the serial %s (%s); %s", serial, strings.Join(found, " "), why)
	case found[0] != name:
		return Disk{}, fmt.Errorf("%s is %s, but the disk that reports %s is %s; %s", path, name, serial, found[0], why)
	}
	if r, _ := os.ReadFile(filepath.Join(block, name, "removable")); strings.TrimSpace(string(r)) != "0" {
		return Disk{}, fmt.Errorf("%s is removable; %s", path, why)
	}
	if target, err := filepath.EvalSymlinks(filepath.Join(block, name)); err == nil && onUSB(target) {
		return Disk{}, fmt.Errorf("%s is on USB; %s", path, why)
	}
	sector := 512
	if b, err := os.ReadFile(filepath.Join(block, name, "queue/logical_block_size")); err == nil {
		if n, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil && n >= 512 {
			sector = n
		}
	}
	e.logf("%s reports the serial %s", path, serial)
	return Disk{Path: path, Name: name, SectorSize: sector}, nil
}

var usbPattern = regexp.MustCompile(`/usb[0-9]`)

func onUSB(sysPath string) bool { return usbPattern.MatchString(sysPath) }

// part is one partition the kernel lists for a disk.
type part struct {
	Name          string
	Number        int
	Start, Length int64 // in 512-byte sectors, as sysfs counts
}

// partitions lists the disk's partitions from sysfs, in number order.
func (e *Executor) partitions(d Disk) ([]part, error) {
	dir := filepath.Join(e.Sys, "block", d.Name)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var out []part
	for _, en := range entries {
		num, err := readInt(filepath.Join(dir, en.Name(), "partition"))
		if err != nil {
			continue
		}
		start, _ := readInt(filepath.Join(dir, en.Name(), "start"))
		size, _ := readInt(filepath.Join(dir, en.Name(), "size"))
		out = append(out, part{Name: en.Name(), Number: int(num), Start: start, Length: size})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Number < out[j].Number })
	return out, nil
}

// partDevice is the device node of partition number n of the disk, which
// the kernel names with or without a p.
func (e *Executor) partDevice(d Disk, n int) (string, bool) {
	parts, err := e.partitions(d)
	if err != nil {
		return "", false
	}
	for _, p := range parts {
		if p.Number == n {
			dev := filepath.Join(e.Dev, p.Name)
			return dev, e.Host.IsBlockDevice(dev)
		}
	}
	return "", false
}

func readInt(path string) (int64, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	return strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64)
}

// diskSize is the disk's size in bytes.
func diskSize(path string) (int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	return f.Seek(0, 2)
}
