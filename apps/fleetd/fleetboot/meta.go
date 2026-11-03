package fleetboot

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"sort"
)

// Talos's META partition holds its key-value store as the Talos ADV of
// github.com/siderolabs/go-adv, which Talos v1.14.5 reads (internal/pkg/meta):
// a 256 KiB block written twice from the partition's start, each
//
//	magic1 (4 bytes), then per tag: tag (4), size (4), value; zero padding;
//	SHA-256 of the block with this field zeroed (32), magic2 (4),
//
// all big-endian, followed at the partition's end by the legacy syslinux ADV,
// which the installer writes as zeros when it holds nothing. Talos reads the
// first block whose magics and checksum hold, then the second.
const (
	ADVLength = 256 * 1024
	advMagic1 = 0x5a4b3c2d
	advMagic2 = 0xa5b4c3d2
	// The syslinux ADV, two 512-byte copies at the end of the partition.
	syslinuxADV = 2 * 512
)

// METADownloadURLCode is the META key Talos fills ${code} from in the
// talos.config URL: meta.DownloadURLCode, 0x0b.
const METADownloadURLCode = 0x0b

// MetaPartition is the GPT name of Talos's META partition.
const MetaPartition = "META"

// unmarshalADV reads one Talos ADV block.
func unmarshalADV(b []byte) (map[uint32][]byte, error) {
	if len(b) != ADVLength {
		return nil, fmt.Errorf("an ADV block is %d bytes, not %d", len(b), ADVLength)
	}
	if binary.BigEndian.Uint32(b[0:4]) != advMagic1 || binary.BigEndian.Uint32(b[len(b)-4:]) != advMagic2 {
		return nil, errors.New("no ADV magic")
	}
	c := append([]byte{}, b...)
	want := append([]byte{}, c[len(c)-36:len(c)-4]...)
	copy(c[len(c)-36:len(c)-4], make([]byte, 32))
	if sum := sha256.Sum256(c); !bytes.Equal(sum[:], want) {
		return nil, errors.New("the ADV checksum does not match")
	}
	tags := map[uint32][]byte{}
	data := b[4 : len(b)-36]
	for len(data) >= 8 {
		tag := binary.BigEndian.Uint32(data[0:4])
		if tag == 0 {
			break
		}
		size := binary.BigEndian.Uint32(data[4:8])
		if uint64(len(data)) < uint64(size)+8 {
			return nil, fmt.Errorf("tag %d's value runs past the block", tag)
		}
		tags[tag] = append([]byte{}, data[8:8+size]...)
		data = data[8+size:]
	}
	return tags, nil
}

// marshalADV writes one Talos ADV block, its tags in ascending order.
func marshalADV(tags map[uint32][]byte) ([]byte, error) {
	b := make([]byte, ADVLength)
	binary.BigEndian.PutUint32(b[0:4], advMagic1)
	binary.BigEndian.PutUint32(b[len(b)-4:], advMagic2)
	keys := make([]uint32, 0, len(tags))
	for k := range tags {
		if k == 0 {
			return nil, errors.New("tag 0 marks the end and holds no value")
		}
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i] < keys[j] })
	data := b[4 : len(b)-36]
	for _, k := range keys {
		v := tags[k]
		if len(v)+8 > len(data) {
			return nil, fmt.Errorf("the ADV overflows by %d bytes", len(v)+8-len(data))
		}
		binary.BigEndian.PutUint32(data[0:4], k)
		binary.BigEndian.PutUint32(data[4:8], uint32(len(v)))
		copy(data[8:], v)
		data = data[8+len(v):]
	}
	sum := sha256.Sum256(b)
	copy(b[len(b)-36:len(b)-4], sum[:])
	return b, nil
}

// readADV reads the tags of the META partition at r: the first copy that
// holds, then the second, and none from a partition with neither, as an
// image's blank META is.
func readADV(r io.ReaderAt) map[uint32][]byte {
	b := make([]byte, ADVLength)
	for _, off := range []int64{0, ADVLength} {
		if _, err := r.ReadAt(b, off); err != nil {
			continue
		}
		if tags, err := unmarshalADV(b); err == nil {
			return tags
		}
	}
	return map[uint32][]byte{}
}

// SetMETA sets key to value in the META partition of length bytes at rw and
// writes both copies, keeping the tags already there, as the Talos
// installer's --meta does. It leaves the syslinux ADV at the end alone.
func SetMETA(rw interface {
	io.ReaderAt
	io.WriterAt
}, length int64, key uint32, value []byte) error {
	if length < 2*ADVLength+syslinuxADV {
		return fmt.Errorf("a %d-byte META partition holds no two ADV copies", length)
	}
	tags := readADV(rw)
	tags[key] = value
	block, err := marshalADV(tags)
	if err != nil {
		return err
	}
	for _, off := range []int64{0, ADVLength} {
		if _, err := rw.WriteAt(block, off); err != nil {
			return err
		}
	}
	return nil
}
