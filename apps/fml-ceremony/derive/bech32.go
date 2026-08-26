package derive

import (
	"fmt"
	"strings"
)

// Bech32 as BIP-173, not Bech32m: age encodes identities and recipients with
// checksum constant 1. It is not in the Go standard library, and the ceremony
// takes no dependencies, so it is here — forty lines, pinned in the tests
// against the age specification's own published example pair.
//
// The age spec removes BIP-173's 90-character limit. Nothing here reaches it
// regardless: the longest string this file produces is 62 characters.

const charset = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"

func bech32Polymod(values []byte) uint32 {
	gen := [5]uint32{0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3}
	chk := uint32(1)
	for _, v := range values {
		b := chk >> 25
		chk = (chk&0x1ffffff)<<5 ^ uint32(v)
		for i := 0; i < 5; i++ {
			if (b>>i)&1 == 1 {
				chk ^= gen[i]
			}
		}
	}
	return chk
}

// hrpExpand is BIP-173's checksum framing of the human-readable part: high bits
// of every character, a separator zero, then low bits.
func hrpExpand(hrp string) []byte {
	out := make([]byte, 0, len(hrp)*2+1)
	for i := 0; i < len(hrp); i++ {
		out = append(out, hrp[i]>>5)
	}
	out = append(out, 0)
	for i := 0; i < len(hrp); i++ {
		out = append(out, hrp[i]&31)
	}
	return out
}

// convertBits regroups a byte string between bit widths. pad is true when
// encoding 8 to 5 (a trailing partial group is zero-filled) and false when
// decoding 5 to 8, where leftover bits must be zero or the input carried
// information the 8-bit form cannot represent.
func convertBits(data []byte, from, to uint, pad bool) ([]byte, error) {
	var acc uint32
	var bits uint
	maxv := uint32(1)<<to - 1
	out := make([]byte, 0, len(data)*int(from)/int(to)+1)
	for _, b := range data {
		// Live in the decode direction, where a 5-bit group above 31 would
		// carry information this regrouping silently drops. In the encode
		// direction every byte is in range and the test is free.
		if b>>from != 0 {
			return nil, fmt.Errorf("bech32: value %d does not fit in %d bits", b, from)
		}
		acc = acc<<from | uint32(b)
		bits += from
		for bits >= to {
			bits -= to
			out = append(out, byte(acc>>bits&maxv))
		}
	}
	if pad {
		if bits > 0 {
			out = append(out, byte(acc<<(to-bits)&maxv))
		}
		return out, nil
	}
	if bits >= from {
		return nil, fmt.Errorf("bech32: %d leftover bits", bits)
	}
	if acc<<(to-bits)&maxv != 0 {
		return nil, fmt.Errorf("bech32: non-zero padding")
	}
	return out, nil
}

// bech32Encode returns the lowercase encoding of data under hrp. Callers that
// want the uppercase form uppercase the whole result: the checksum is always
// computed over the lowercase string, so uppercasing afterwards is the only
// order that produces a string other implementations accept.
func bech32Encode(hrp string, data []byte) (string, error) {
	// BIP-173 computes the checksum over the lowercase human-readable part.
	// age's identity HRP is written "AGE-SECRET-KEY-", so encoding must fold it
	// here and the caller uppercases the finished string; checksumming the
	// uppercase HRP instead yields six wrong trailing characters and nothing
	// else, which is a hard failure to spot by eye.
	hrp = strings.ToLower(hrp)
	conv, err := convertBits(data, 8, 5, true)
	if err != nil {
		return "", err
	}
	values := append(hrpExpand(hrp), conv...)
	polymod := bech32Polymod(append(values, 0, 0, 0, 0, 0, 0)) ^ 1
	var sb strings.Builder
	sb.WriteString(hrp)
	sb.WriteByte('1')
	for _, v := range conv {
		sb.WriteByte(charset[v])
	}
	for i := 0; i < 6; i++ {
		sb.WriteByte(charset[polymod>>(5*(5-i))&31])
	}
	return sb.String(), nil
}

// bech32Decode is the rejection half of SPEC.md section 9: mixed case, a bad
// checksum, a character outside the charset, and non-zero padding bits in the
// 5-to-8 conversion all abort.
func bech32Decode(s string) (hrp string, data []byte, err error) {
	if strings.ToLower(s) != s && strings.ToUpper(s) != s {
		return "", nil, fmt.Errorf("bech32: mixed case")
	}
	lower := strings.ToLower(s)
	// The age HRP "AGE-SECRET-KEY-" itself ends in "-", and bech32's separator
	// is "1", so the split must be at the last "1", not the first.
	sep := strings.LastIndexByte(lower, '1')
	if sep < 1 || sep+7 > len(lower) {
		return "", nil, fmt.Errorf("bech32: no separator")
	}
	hrp = lower[:sep]
	for i := 0; i < len(hrp); i++ {
		if hrp[i] < 33 || hrp[i] > 126 {
			return "", nil, fmt.Errorf("bech32: character out of range in human-readable part")
		}
	}
	body := lower[sep+1:]
	values := make([]byte, 0, len(body))
	for i := 0; i < len(body); i++ {
		v := strings.IndexByte(charset, body[i])
		if v < 0 {
			return "", nil, fmt.Errorf("bech32: %q is not in the charset", body[i])
		}
		values = append(values, byte(v))
	}
	if bech32Polymod(append(hrpExpand(hrp), values...)) != 1 {
		return "", nil, fmt.Errorf("bech32: bad checksum")
	}
	data, err = convertBits(values[:len(values)-6], 5, 8, false)
	if err != nil {
		return "", nil, err
	}
	return hrp, data, nil
}
