package fleetboot

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"strings"
	"unicode/utf16"
)

// Partition type GUIDs the steps look for.
const (
	TypeESP       = "c12a7328-f81f-11d2-ba4b-00a0c93ec93b"
	TypeLinuxRoot = "4f68bce3-e8cd-4db1-96e7-fbcaf984b709"
)

// Partition is one used entry of a GUID partition table. Number counts from
// 1 in table order, as the kernel numbers partitions.
type Partition struct {
	Number      int
	Type        string
	GUID        string
	First, Last uint64
	Name        string
}

// GPT is the primary partition table of a disk.
type GPT struct {
	SectorSize   int
	AlternateLBA uint64
	LastUsable   uint64
	Partitions   []Partition
}

// guid renders a GPT GUID, whose first three fields are little-endian, as
// lower-case text.
func guid(b []byte) string {
	return fmt.Sprintf("%08x-%04x-%04x-%x-%x",
		binary.LittleEndian.Uint32(b[0:4]), binary.LittleEndian.Uint16(b[4:6]), binary.LittleEndian.Uint16(b[6:8]), b[8:10], b[10:16])
}

// ReadGPT reads the primary GPT of a disk with the sector size, checking the
// header's and the entries' CRC32.
func ReadGPT(r io.ReaderAt, sectorSize int) (GPT, error) {
	if sectorSize < 512 {
		return GPT{}, fmt.Errorf("sector size %d", sectorSize)
	}
	hdr := make([]byte, sectorSize)
	if _, err := r.ReadAt(hdr, int64(sectorSize)); err != nil {
		return GPT{}, fmt.Errorf("read the GPT header: %w", err)
	}
	if !bytes.Equal(hdr[0:8], []byte("EFI PART")) {
		return GPT{}, errors.New("no GPT header at LBA 1")
	}
	size := binary.LittleEndian.Uint32(hdr[12:16])
	if size < 92 || int(size) > sectorSize {
		return GPT{}, fmt.Errorf("the GPT header size %d is invalid", size)
	}
	h := append([]byte{}, hdr[:size]...)
	want := binary.LittleEndian.Uint32(h[16:20])
	binary.LittleEndian.PutUint32(h[16:20], 0)
	if crc32.ChecksumIEEE(h) != want {
		return GPT{}, errors.New("the GPT header's CRC does not match")
	}
	g := GPT{
		SectorSize:   sectorSize,
		AlternateLBA: binary.LittleEndian.Uint64(hdr[32:40]),
		LastUsable:   binary.LittleEndian.Uint64(hdr[48:56]),
	}
	entriesLBA := binary.LittleEndian.Uint64(hdr[72:80])
	count := binary.LittleEndian.Uint32(hdr[80:84])
	entrySize := binary.LittleEndian.Uint32(hdr[84:88])
	if entrySize < 128 || count > 1024 {
		return GPT{}, fmt.Errorf("the GPT has %d entries of %d bytes", count, entrySize)
	}
	entries := make([]byte, int(count)*int(entrySize))
	if _, err := r.ReadAt(entries, int64(entriesLBA)*int64(sectorSize)); err != nil {
		return GPT{}, fmt.Errorf("read the GPT entries: %w", err)
	}
	if crc32.ChecksumIEEE(entries) != binary.LittleEndian.Uint32(hdr[88:92]) {
		return GPT{}, errors.New("the GPT entries' CRC does not match")
	}
	for i := 0; i < int(count); i++ {
		e := entries[i*int(entrySize) : (i+1)*int(entrySize)]
		if bytes.Equal(e[0:16], make([]byte, 16)) {
			continue
		}
		name := make([]uint16, 36)
		for j := range name {
			name[j] = binary.LittleEndian.Uint16(e[56+2*j:])
		}
		g.Partitions = append(g.Partitions, Partition{
			Number: i + 1,
			Type:   guid(e[0:16]),
			GUID:   guid(e[16:32]),
			First:  binary.LittleEndian.Uint64(e[32:40]),
			Last:   binary.LittleEndian.Uint64(e[40:48]),
			Name:   strings.TrimRight(string(utf16.Decode(name)), "\x00"),
		})
	}
	return g, nil
}

// OfType is the first partition whose type GUID is t.
func (g GPT) OfType(t string) (Partition, bool) {
	for _, p := range g.Partitions {
		if strings.EqualFold(p.Type, t) {
			return p, true
		}
	}
	return Partition{}, false
}

// Named is the first partition with the GPT name.
func (g GPT) Named(name string) (Partition, bool) {
	for _, p := range g.Partitions {
		if p.Name == name {
			return p, true
		}
	}
	return Partition{}, false
}

// Bytes is the partition's offset and length on the disk.
func (p Partition) Bytes(sectorSize int) (offset, length int64) {
	return int64(p.First) * int64(sectorSize), int64(p.Last-p.First+1) * int64(sectorSize)
}

// BackupAtEnd says whether the backup header sits on the disk's last
// sector, which a disk image written to a larger disk leaves short of.
func (g GPT) BackupAtEnd(diskBytes int64) bool {
	return int64(g.AlternateLBA+1)*int64(g.SectorSize) == diskBytes
}
