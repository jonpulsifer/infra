package fleetboot

import (
	"context"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"hash/crc32"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"unicode/utf16"

	"github.com/jonpulsifer/infra/apps/fleetd/protocol"
)

// testPart is one partition a test GPT declares, in 512-byte sectors.
type testPart struct {
	typ, guid   string
	first, last uint64
	name        string
}

func guidBytes(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(strings.ReplaceAll(s, "-", ""))
	if err != nil || len(b) != 16 {
		t.Fatalf("guid %q", s)
	}
	out := make([]byte, 16)
	binary.LittleEndian.PutUint32(out[0:], binary.BigEndian.Uint32(b[0:4]))
	binary.LittleEndian.PutUint16(out[4:], binary.BigEndian.Uint16(b[4:6]))
	binary.LittleEndian.PutUint16(out[6:], binary.BigEndian.Uint16(b[6:8]))
	copy(out[8:], b[8:])
	return out
}

// makeGPT builds a disk image of sectors 512-byte sectors with a protective
// MBR, the primary GPT and the partitions' table entries.
func makeGPT(t *testing.T, sectors int64, parts []testPart) []byte {
	t.Helper()
	img := make([]byte, sectors*512)
	img[510], img[511] = 0x55, 0xaa
	entries := make([]byte, 128*128)
	for i, p := range parts {
		e := entries[i*128:]
		copy(e[0:16], guidBytes(t, p.typ))
		copy(e[16:32], guidBytes(t, p.guid))
		binary.LittleEndian.PutUint64(e[32:], p.first)
		binary.LittleEndian.PutUint64(e[40:], p.last)
		for j, r := range utf16.Encode([]rune(p.name)) {
			binary.LittleEndian.PutUint16(e[56+2*j:], r)
		}
	}
	copy(img[1024:], entries)
	h := img[512:604]
	copy(h[0:8], "EFI PART")
	binary.LittleEndian.PutUint32(h[8:], 0x00010000)
	binary.LittleEndian.PutUint32(h[12:], 92)
	binary.LittleEndian.PutUint64(h[24:], 1)
	binary.LittleEndian.PutUint64(h[32:], uint64(sectors-1))
	binary.LittleEndian.PutUint64(h[40:], 34)
	binary.LittleEndian.PutUint64(h[48:], uint64(sectors-34))
	binary.LittleEndian.PutUint64(h[72:], 2)
	binary.LittleEndian.PutUint32(h[80:], 128)
	binary.LittleEndian.PutUint32(h[84:], 128)
	binary.LittleEndian.PutUint32(h[88:], crc32.ChecksumIEEE(entries))
	binary.LittleEndian.PutUint32(h[16:], crc32.ChecksumIEEE(h))
	return img
}

const (
	espGUID  = "0a1b2c3d-4e5f-4061-8273-8495a6b7c8d9"
	rootGUID = "11111111-2222-4333-8444-555555555555"
)

// machine is a fake machine: a sysfs and /dev under a temporary directory,
// a disk that is a regular file, and a record of every tool run.
type machine struct {
	t    *testing.T
	root string
	sys  string
	dev  string
	efi  string
	ram  string
	disk string

	mu       sync.Mutex
	calls    []string
	block    map[string]bool
	efiVars  *fakeEFI
	run      map[string]func(args []string) ([]byte, error)
	mounts   []string
	rebooted string
	// remountErr is efivarfs refusing to turn writable.
	remountErr error
}

func newMachine(t *testing.T, diskBytes int64) *machine {
	t.Helper()
	root := t.TempDir()
	m := &machine{
		t: t, root: root,
		sys: filepath.Join(root, "sys"), dev: filepath.Join(root, "dev"),
		efi: filepath.Join(root, "efivars"), ram: filepath.Join(root, "ram"),
		block: map[string]bool{}, run: map[string]func([]string) ([]byte, error){},
		efiVars: &fakeEFI{},
	}
	for _, d := range []string{m.sys, m.dev, m.efi, m.ram, filepath.Join(m.sys, "block")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	m.disk = m.addDisk("nvme0n1", "S5GXNX0R123456", diskBytes)
	return m
}

// addDisk adds a whole disk that reports serial, with its device file.
func (m *machine) addDisk(name, serial string, size int64) string {
	m.t.Helper()
	dir := filepath.Join(m.sys, "block", name)
	m.write(filepath.Join(dir, "device/serial"), serial+"\n")
	m.write(filepath.Join(dir, "removable"), "0\n")
	m.write(filepath.Join(dir, "queue/logical_block_size"), "512\n")
	dev := filepath.Join(m.dev, name)
	f, err := os.Create(dev)
	if err != nil {
		m.t.Fatal(err)
	}
	if err := f.Truncate(size); err != nil {
		m.t.Fatal(err)
	}
	f.Close()
	m.block[dev] = true
	return dev
}

// addPart lists partition n of a disk in sysfs, with its device file.
func (m *machine) addPart(disk string, n int, start, size int64) string {
	m.t.Helper()
	name := fmt.Sprintf("%sp%d", disk, n)
	dir := filepath.Join(m.sys, "block", disk, name)
	m.write(filepath.Join(dir, "partition"), fmt.Sprint(n))
	m.write(filepath.Join(dir, "start"), fmt.Sprint(start))
	m.write(filepath.Join(dir, "size"), fmt.Sprint(size))
	dev := filepath.Join(m.dev, name)
	if err := os.WriteFile(dev, make([]byte, 0), 0o644); err != nil {
		m.t.Fatal(err)
	}
	m.block[dev] = true
	return dev
}

func (m *machine) write(path, s string) {
	m.t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		m.t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(s), 0o644); err != nil {
		m.t.Fatal(err)
	}
}

func (m *machine) Run(_ context.Context, name string, args ...string) ([]byte, error) {
	m.mu.Lock()
	m.calls = append(m.calls, strings.Join(append([]string{name}, args...), " "))
	fn := m.run[name]
	m.mu.Unlock()
	if fn != nil {
		return fn(args)
	}
	switch name {
	case "blkid":
		return nil, exitErr(2)
	case "efibootmgr":
		return m.efiVars.run(args)
	}
	return nil, nil
}

func (m *machine) IsBlockDevice(path string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.block[path]
}

func (m *machine) Mount(source, target, fstype, _ string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.mounts = append(m.mounts, source+" "+target+" "+fstype)
	return nil
}

func (m *machine) IsMountpoint(path string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, mnt := range m.mounts {
		if strings.Fields(mnt)[1] == path {
			return true
		}
	}
	return false
}

func (m *machine) Remount(string) error        { return m.remountErr }
func (m *machine) Unmount(string) error        { return nil }
func (m *machine) ClearImmutable(string) error { return nil }
func (m *machine) Sync()                       {}
func (m *machine) Reboot(off bool) error {
	m.rebooted = map[bool]string{true: "off", false: "reboot"}[off]
	return nil
}

func (m *machine) ran(prefix string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, c := range m.calls {
		if strings.HasPrefix(c, prefix) {
			return true
		}
	}
	return false
}

func (m *machine) executor(r Reporter) *Executor {
	return &Executor{
		Host: m, Reporter: r, Logf: m.t.Logf,
		Sys: m.sys, Dev: m.dev, EFIVars: m.efi, RAM: m.ram,
		UUID: "4c4c4544-0000-0000-0000-000000000000", Code: strings.Repeat("A", 43),
		MaxImage: 64 << 20, EraseBudget: 780e9,
	}
}

// punch makes a range of the disk read as zeros, as a discard that works
// does.
func punch(t *testing.T, path string, off, length int64) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	const punchHole, keepSize = 0x02, 0x01
	if err := syscall.Fallocate(int(f.Fd()), punchHole|keepSize, off, length); err == nil {
		return
	}
	zero := make([]byte, 1<<20)
	for done := int64(0); done < length; {
		n := min(int64(len(zero)), length-done)
		if _, err := f.WriteAt(zero[:n], off+done); err != nil {
			t.Fatal(err)
		}
		done += n
	}
}

// fakeEFI is the firmware's boot variables as efibootmgr shows them.
type fakeEFI struct {
	entries []BootEntry
	order   []string
	next    string
	created int
}

func (f *fakeEFI) run(args []string) ([]byte, error) {
	i := 0
	for i < len(args) {
		switch args[i] {
		case "-v", "-q":
			i++
		case "-c":
			var disk, part, label string
			for j := i + 1; j+1 < len(args); j += 2 {
				switch args[j] {
				case "-d":
					disk = args[j+1]
				case "-p":
					part = args[j+1]
				case "-L":
					label = args[j+1]
				}
			}
			_ = disk
			f.created++
			num := fmt.Sprintf("%04X", 0x10+f.created)
			f.entries = append(f.entries, BootEntry{Num: num, Active: true, Label: label, Path: fmt.Sprintf("HD(%s,GPT,%s,0x800,0x800)/File(\\EFI\\BOOT\\BOOTX64.EFI)", part, espGUID)})
			f.order = append([]string{num}, f.order...)
			return nil, nil
		case "-b":
			num := strings.ToUpper(args[i+1])
			var keep []BootEntry
			for _, e := range f.entries {
				if e.Num != num {
					keep = append(keep, e)
				}
			}
			f.entries = keep
			return nil, nil
		case "-o":
			f.order = strings.Split(args[i+1], ",")
			return nil, nil
		case "-n":
			f.next = args[i+1]
			return nil, nil
		default:
			i++
		}
	}
	var b strings.Builder
	if f.next != "" {
		fmt.Fprintf(&b, "BootNext: %s\n", f.next)
	}
	fmt.Fprintf(&b, "BootCurrent: 0001\nTimeout: 0 seconds\nBootOrder: %s\n", strings.Join(f.order, ","))
	for _, e := range f.entries {
		star := ""
		if e.Active {
			star = "*"
		}
		fmt.Fprintf(&b, "Boot%s%s %s\t%s\n", e.Num, star, e.Label, e.Path)
	}
	return []byte(b.String()), nil
}

// reports records what fleetd would take; failAt makes one report fail.
type reports struct {
	mu     sync.Mutex
	got    []protocol.BootReport
	failAt string
}

func (r *reports) Report(_ context.Context, b protocol.BootReport) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.failAt == b.Step+" "+b.Phase {
		return errors.New("fleetd is down")
	}
	r.got = append(r.got, b)
	return nil
}

func (r *reports) phases() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []string
	for _, b := range r.got {
		out = append(out, b.Step+" "+b.Phase)
	}
	return out
}

var errUnsupported = errors.New("exit status 1")

// exitErr is a command that exited with a status.
type exitErr int

func (e exitErr) Error() string { return fmt.Sprintf("exit status %d", int(e)) }
func (e exitErr) ExitCode() int { return int(e) }
