package fleetboot

import (
	"archive/tar"
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/jonpulsifer/infra/apps/fleetd/protocol"
)

func TestReadGPT(t *testing.T) {
	img := makeGPT(t, 8192, []testPart{
		{TypeESP, espGUID, 2048, 4095, "ESP"},
		{TypeLinuxRoot, rootGUID, 4096, 8158, "root"},
	})
	g, err := ReadGPT(bytes.NewReader(img), 512)
	if err != nil {
		t.Fatal(err)
	}
	if len(g.Partitions) != 2 {
		t.Fatalf("partitions %+v", g.Partitions)
	}
	esp, ok := g.OfType(TypeESP)
	if !ok || esp.Number != 1 || esp.GUID != espGUID || esp.Name != "ESP" {
		t.Errorf("ESP %+v", esp)
	}
	if p, ok := g.Named("root"); !ok || p.Number != 2 || p.Type != TypeLinuxRoot {
		t.Errorf("root %+v", p)
	}
	if off, n := esp.Bytes(512); off != 2048*512 || n != 2048*512 {
		t.Errorf("ESP bytes %d+%d", off, n)
	}
	// Written to a disk twice its size, the backup header is short of the end.
	if !g.BackupAtEnd(8192*512) || g.BackupAtEnd(16384*512) {
		t.Error("BackupAtEnd")
	}
	bad := append([]byte{}, img...)
	bad[1024+40]++
	if _, err := ReadGPT(bytes.NewReader(bad), 512); err == nil {
		t.Error("a table whose entries' CRC does not match read")
	}
	bad = append([]byte{}, img...)
	bad[512+40]++
	if _, err := ReadGPT(bytes.NewReader(bad), 512); err == nil {
		t.Error("a header whose CRC does not match read")
	}
	if _, err := ReadGPT(bytes.NewReader(make([]byte, 4096)), 512); err == nil {
		t.Error("a blank disk read as a GPT")
	}
}

func TestDetectFormat(t *testing.T) {
	gpt := makeGPT(t, 64, nil)
	mbr := make([]byte, 512)
	mbr[510], mbr[511] = 0x55, 0xaa
	for want, head := range map[string][]byte{
		"raw.zst": {0x28, 0xb5, 0x2f, 0xfd, 0, 0},
		"raw.gz":  {0x1f, 0x8b, 8, 0},
		"tar.xz":  {0xfd, '7', 'z', 'X', 'Z', 0, 0},
		"raw":     gpt,
		"":        []byte("#!/bin/sh\n"),
	} {
		if got := DetectFormat(head); got != want {
			t.Errorf("DetectFormat = %q, want %q", got, want)
		}
	}
	if got := DetectFormat(mbr); got != "raw" {
		t.Errorf("an MBR disk is %q", got)
	}
}

func TestDecodeCommands(t *testing.T) {
	if got := decodeCommands("tar.xz", "/x"); !reflect.DeepEqual(got, [][]string{{"xz", "-dc", "/x"}}) {
		t.Errorf("tar.xz: %v", got)
	}
	if got := decodeCommands("raw.zst", "/x"); !reflect.DeepEqual(got, [][]string{{"zstd", "-dc", "/x"}}) {
		t.Errorf("raw.zst: %v", got)
	}
	if decodeCommands("iso", "/x") != nil {
		t.Error("an unknown format has a decoder")
	}
}

func imageRun() protocol.BootRun {
	return protocol.BootRun{
		Run: "provision-x-1", Action: "provision", Attest: true, Wipe: true, Install: true,
		Disk: "/dev/nvme0n1", DiskSerial: "S5GXNX0R123456",
		ImageURL: "https://example.com/i.img.zst", ImageDigest: "sha256:" + strings.Repeat("a", 64), ImageFormat: "raw.zst",
		PayloadKind: "nixos-image", OS: "nixos", SeedURL: "https://enroll.example/seed",
	}
}

// A run whose install inputs are malformed is refused before anything is
// wiped.
func TestPreflight(t *testing.T) {
	code := strings.Repeat("A", 43)
	if err := preflight(imageRun(), code); err != nil {
		t.Fatal(err)
	}
	if err := preflight(protocol.BootRun{Wipe: true}, ""); err != nil {
		t.Errorf("a wipe needs no install inputs: %v", err)
	}
	for name, c := range map[string]struct {
		edit func(*protocol.BootRun)
		code string
	}{
		"no code":         {func(*protocol.BootRun) {}, ""},
		"short code":      {func(*protocol.BootRun) {}, "abc"},
		"code with a dot": {func(*protocol.BootRun) {}, strings.Repeat("A", 42) + "."},
		"install no wipe": {func(r *protocol.BootRun) { r.Wipe = false }, code},
		"a container": {func(r *protocol.BootRun) {
			r.ImageURL = ""
			r.InstallerImage = "ghcr.io/x@sha256:" + strings.Repeat("0", 64)
		}, code},
		"upper-case hex":    {func(r *protocol.BootRun) { r.ImageDigest = "sha256:" + strings.Repeat("A", 64) }, code},
		"short digest":      {func(r *protocol.BootRun) { r.ImageDigest = "sha256:abc" }, code},
		"http image":        {func(r *protocol.BootRun) { r.ImageURL = "http://example.com/i" }, code},
		"unknown format":    {func(r *protocol.BootRun) { r.ImageFormat = "qcow2" }, code},
		"talos payload":     {func(r *protocol.BootRun) { r.PayloadKind = "talos-machineconfig" }, code},
		"http seed":         {func(r *protocol.BootRun) { r.SeedURL = "http://enroll.example/seed" }, code},
		"seed with ?":       {func(r *protocol.BootRun) { r.SeedURL = "https://enroll.example/seed?x=1" }, code},
		"seed with no host": {func(r *protocol.BootRun) { r.SeedURL = "https://" }, code},
	} {
		r := imageRun()
		c.edit(&r)
		err := preflight(r, c.code)
		if err == nil {
			t.Errorf("%s: accepted", name)
			continue
		}
		if !strings.Contains(err.Error(), "nothing wiped") {
			t.Errorf("%s: %v does not say nothing was wiped", name, err)
		}
	}
}

const bootOut = "BootCurrent: 0001\nBootNext: 0004\nTimeout: 0 seconds\nBootOrder: 0001,0003,0009,0002\n" +
	"Boot0001* Talos Linux UKI\tHD(1,GPT,aaaaaaaa-0000-4000-8000-000000000001,0x800,0x32000)/File(\\EFI\\boot\\BOOTX64.efi)\n" +
	"Boot0002* UEFI: IPV4 Intel(R) Ethernet Connection I219-LM\tPciRoot(0x0)/Pci(0x1f,0x6)/MAC(001122334455,0)/IPv4(0.0.0.0,0,DHCP)\n" +
	"Boot0003  debian\tHD(2,GPT,bbbbbbbb-0000-4000-8000-000000000002,0x1000,0x100000)/File(\\EFI\\debian\\shimx64.efi)\n" +
	"Boot0005* Windows Boot Manager\tHD(1,GPT,cccccccc-0000-4000-8000-000000000003,0x800,0x32000)/File(\\EFI\\Microsoft\\Boot\\bootmgfw.efi)\n" +
	"Boot0006* fleet nixos\tHD(1,GPT,DDDDDDDD-0000-4000-8000-000000000004,0x800,0x100000)/File(\\EFI\\BOOT\\BOOTX64.EFI)\n"

func TestParseBootVars(t *testing.T) {
	v := ParseBootVars([]byte(bootOut))
	if v.Next != "0004" || !reflect.DeepEqual(v.Order, []string{"0001", "0003", "0009", "0002"}) || len(v.Entries) != 5 {
		t.Fatalf("%+v", v)
	}
	if e := v.Entries[2]; e.Num != "0003" || e.Active || e.Label != "debian" {
		t.Errorf("Boot0003 %+v", e)
	}
	if e, ok := v.ForESP(1, "dddddddd-0000-4000-8000-000000000004"); !ok || e.Num != "0006" {
		t.Errorf("ForESP %+v %v", e, ok)
	}
	if _, ok := v.ForESP(2, "dddddddd-0000-4000-8000-000000000004"); ok {
		t.Error("ForESP matched another partition number")
	}
	var stale []string
	for _, e := range v.Stale("dddddddd-0000-4000-8000-000000000004") {
		stale = append(stale, e.Num)
	}
	if !reflect.DeepEqual(stale, []string{"0001", "0003"}) {
		t.Errorf("stale %v: the kept entry and Windows stay", stale)
	}
	if n := len(v.Stale("")); n != 3 {
		t.Errorf("a retirement deletes %d fleet entries, want 3", n)
	}
	if e, ok := v.IPv4(); !ok || e.Num != "0002" {
		t.Errorf("IPv4 %+v", e)
	}
	// 0009 has no entry and drops out.
	if got := v.OrderWithFirst("0006"); !reflect.DeepEqual(got, []string{"0006", "0001", "0003", "0002"}) {
		t.Errorf("order %v", got)
	}
}

func TestNVMeParsing(t *testing.T) {
	ctrl := []byte("NVME Identify Controller:\nvid       : 0x144d\noacs      : 0x5f\nsanicap   : 0x2\nfna       : 0x4\n")
	if v, ok := nvmeField(ctrl, "sanicap"); !ok || v != 2 {
		t.Errorf("sanicap %d %v", v, ok)
	}
	if _, ok := nvmeField(ctrl, "sanica"); ok {
		t.Error("a prefix matched")
	}
	if sanitizeAction(1) != 4 || sanitizeAction(3) != 4 || sanitizeAction(2) != 2 || sanitizeAction(0) != 0 {
		t.Error("sanitizeAction")
	}
	if st, ok := sanitizeStatus([]byte("Sanitize Progress                      (SPROG) :  65535\nSanitize Status                        (SSTAT) :  0x101\n")); !ok || st&7 != 1 {
		t.Errorf("sstat %#x %v", st, ok)
	}
	if ses, lbaf, ok := formatArgs(0x5f, 0x4, 0x10|0x40); !ok || ses != 2 || lbaf != (0|(2<<4)) {
		t.Errorf("format %d %d %v", ses, lbaf, ok)
	}
	if ses, _, ok := formatArgs(0x2, 0, 0); !ok || ses != 1 {
		t.Error("a format without crypto erase support erases the user data")
	}
	if _, _, ok := formatArgs(0x5d, 0, 0); ok {
		t.Error("OACS without format support formats")
	}
}

func TestPlanSamples(t *testing.T) {
	const gib = int64(1) << 30
	s := planSamples(256*gib, []part{{Number: 1, Start: 2048, Length: 1048576}, {Number: 2, Start: 1050624, Length: 1000}})
	if len(s) != 19 {
		t.Fatalf("%d samples, want 16 over the disk and 3 in the partition of 512 MiB", len(s))
	}
	for _, b := range s[:16] {
		if b < 4096 || b*block >= 256*gib {
			t.Errorf("block %d is in the first 16 MiB or past the end", b)
		}
	}
	if s[16] != 2048/8+8192 || s[18] != (2048+1048576)/8-256 {
		t.Errorf("partition samples %v", s[16:])
	}
}

func tarOf(t *testing.T, files map[string]string, extra ...*tar.Header) []byte {
	t.Helper()
	var b bytes.Buffer
	w := tar.NewWriter(&b)
	for name, body := range files {
		if err := w.WriteHeader(&tar.Header{Name: name, Mode: 0o600, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		w.Write([]byte(body))
	}
	for _, h := range extra {
		if err := w.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
	}
	w.Close()
	return b.Bytes()
}

func TestSeedTar(t *testing.T) {
	good := tarOf(t, map[string]string{"user-data": "#cloud-config\n", "meta-data": "instance-id: x\n"})
	dest := filepath.Join(t.TempDir(), NoCloudDir)
	if err := extractSeed(good, dest); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(dest, "user-data")); string(b) != "#cloud-config\n" {
		t.Errorf("user-data %q", b)
	}
	for name, b := range map[string][]byte{
		"absolute":   tarOf(t, map[string]string{"/etc/passwd": "x"}),
		"dot-dot":    tarOf(t, map[string]string{"../../etc/shadow": "x"}),
		"inner ..":   tarOf(t, map[string]string{"a/../../b": "x"}),
		"a symlink":  tarOf(t, nil, &tar.Header{Name: "user-data", Typeflag: tar.TypeSymlink, Linkname: "/etc/shadow"}),
		"no meta":    tarOf(t, map[string]string{"user-data": "x"}),
		"empty user": tarOf(t, map[string]string{"user-data": "", "meta-data": "x"}),
	} {
		if err := extractSeed(b, filepath.Join(t.TempDir(), "d")); err == nil {
			t.Errorf("%s: extracted", name)
		}
	}
}

func TestLargestExt4(t *testing.T) {
	img := makeGPT(t, 16384, []testPart{
		{TypeESP, espGUID, 2048, 4095, "ESP"},
		{"0fc63daf-8483-4772-8e79-3d69d8477de4", rootGUID, 4096, 6143, "small"},
		{"0fc63daf-8483-4772-8e79-3d69d8477de4", "22222222-2222-4333-8444-555555555555", 6144, 16000, "big"},
		{"0fc63daf-8483-4772-8e79-3d69d8477de4", "33333333-2222-4333-8444-555555555555", 16001, 16300, "not ext4"},
	})
	for _, first := range []int64{4096, 6144} {
		binary.LittleEndian.PutUint16(img[first*512+1080:], ext4Magic)
	}
	g, err := ReadGPT(bytes.NewReader(img), 512)
	if err != nil {
		t.Fatal(err)
	}
	p, ok := largestExt4(bytes.NewReader(img), g)
	if !ok || p.Name != "big" {
		t.Errorf("largest ext4 %+v %v", p, ok)
	}
}
