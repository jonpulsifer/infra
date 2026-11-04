package fleetboot

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// memPart is a META partition in memory.
type memPart []byte

func (m memPart) ReadAt(b []byte, off int64) (int, error)  { return copy(b, m[off:]), nil }
func (m memPart) WriteAt(b []byte, off int64) (int, error) { return copy(m[off:], b), nil }

// The block SetMETA writes is go-adv's Talos ADV, byte for byte as its
// layout comment gives it, in both copies.
func TestSetMETALayout(t *testing.T) {
	part := make(memPart, 1<<20)
	code := strings.Repeat("Q", 43)
	if err := SetMETA(part, int64(len(part)), METADownloadURLCode, []byte(code)); err != nil {
		t.Fatal(err)
	}
	b := part[:ADVLength]
	if got := binary.BigEndian.Uint32(b[0:]); got != 0x5a4b3c2d {
		t.Errorf("magic1 %#x", got)
	}
	if tag, size := binary.BigEndian.Uint32(b[4:]), binary.BigEndian.Uint32(b[8:]); tag != 0x0b || size != 43 {
		t.Errorf("tag %#x size %d", tag, size)
	}
	if string(b[12:55]) != code || !bytes.Equal(b[55:63], make([]byte, 8)) {
		t.Error("the value is not followed by the end tag")
	}
	if got := binary.BigEndian.Uint32(b[ADVLength-4:]); got != 0xa5b4c3d2 {
		t.Errorf("magic2 %#x", got)
	}
	zeroed := append([]byte{}, b...)
	copy(zeroed[ADVLength-36:ADVLength-4], make([]byte, 32))
	if sum := sha256.Sum256(zeroed); !bytes.Equal(sum[:], b[ADVLength-36:ADVLength-4]) {
		t.Error("the checksum is not SHA-256 of the block with it zeroed")
	}
	if !bytes.Equal(part[ADVLength:2*ADVLength], b) {
		t.Error("the second copy differs")
	}
	if !bytes.Equal(part[2*ADVLength:], make([]byte, len(part)-2*ADVLength)) {
		t.Error("the write ran past the two copies")
	}
}

// A META that holds tags keeps them; one whose first copy is damaged is
// read from the second.
func TestSetMETAKeepsTags(t *testing.T) {
	part := make(memPart, 1<<20)
	if err := SetMETA(part, int64(len(part)), 0x0a, []byte("network")); err != nil {
		t.Fatal(err)
	}
	part[100]++
	if err := SetMETA(part, int64(len(part)), METADownloadURLCode, []byte("code")); err != nil {
		t.Fatal(err)
	}
	tags := readADV(part)
	if string(tags[0x0a]) != "network" || string(tags[METADownloadURLCode]) != "code" {
		t.Errorf("tags %v", tags)
	}
	if err := SetMETA(make(memPart, ADVLength), ADVLength, 0x0b, nil); err == nil {
		t.Error("a partition too small for two copies took them")
	}
	if len(readADV(make(memPart, 1<<20))) != 0 {
		t.Error("a blank META has tags")
	}
}

// A Talos image gets the install code in its META partition, which its
// first boot fills ${code} from, and boots from its ESP next.
func TestRunWritesTheCodeToATalosImage(t *testing.T) {
	m := newMachine(t, 32<<20)
	m.addPart("nvme0n1", 1, 2048, 2048)
	img := makeGPT(t, 16384, []testPart{
		{TypeESP, espGUID, 2048, 4095, "EFI"},
		{"0fc63daf-8483-4772-8e79-3d69d8477de4", rootGUID, 4096, 6143, "META"},
		{"0fc63daf-8483-4772-8e79-3d69d8477de4", "22222222-2222-4333-8444-555555555555", 6144, 16000, "STATE"},
	})
	sum := sha256.Sum256(img)
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write(img) }))
	defer srv.Close()
	run := imageRun()
	run.Disk, run.ImageURL, run.ImageFormat = m.disk, srv.URL+"/metal.raw", "raw"
	run.ImageDigest = "sha256:" + hex.EncodeToString(sum[:])
	run.PayloadKind, run.OS, run.SeedURL = "talos-machineconfig", "talos", ""
	run.InstallerImage = "ghcr.io/jonpulsifer/talos-installer-folly@sha256:" + strings.Repeat("1", 64)
	e := m.executor(&reports{})
	e.HTTP = srv.Client()
	if err := e.Run(context.Background(), run); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(m.disk)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	meta := make(memPart, 2048*512)
	if _, err := f.ReadAt(meta, 4096*512); err != nil {
		t.Fatal(err)
	}
	if got := readADV(meta)[METADownloadURLCode]; string(got) != e.Code {
		t.Errorf("META 0x0b %q", got)
	}
	if !m.ran("blockdev --flushbufs " + m.disk) {
		t.Error("the read-back did not drop the disk's buffers")
	}
	if len(m.efiVars.entries) != 1 || m.efiVars.entries[0].Label != "fleet talos" {
		t.Errorf("entries %+v", m.efiVars.entries)
	}
}

// Talos keeps a byte of each tag, so a tag above 255 reads as its low byte;
// it cannot hide from the code a key Talos would read as 0x0b.
func TestADVTagsAreBytes(t *testing.T) {
	block, err := marshalADV(map[uint8][]byte{0x0a: []byte("x")})
	if err != nil {
		t.Fatal(err)
	}
	// Rewrite tag 0x0a as 0x10b, as a foreign writer might, and reseal.
	binary.BigEndian.PutUint32(block[4:], 0x10b)
	copy(block[ADVLength-36:ADVLength-4], make([]byte, 32))
	sum := sha256.Sum256(block)
	copy(block[ADVLength-36:ADVLength-4], sum[:])
	tags, err := unmarshalADV(block)
	if err != nil {
		t.Fatal(err)
	}
	if string(tags[0x0b]) != "x" {
		t.Errorf("tags %v: 0x10b must read as 0x0b, as Talos reads it", tags)
	}
}
