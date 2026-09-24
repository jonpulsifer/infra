package derive

import (
	"fmt"
	"strings"
)

// BIP-173 Bech32 with checksum constant 1, not Bech32m: age encodes identities
// and recipients with it.

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

// With pad, a trailing partial group is zero-filled (encoding 8 to 5). Without
// it, leftover bits must be zero (decoding 5 to 8).
func convertBits(data []byte, from, to uint, pad bool) ([]byte, error) {
	var acc uint32
	var bits uint
	maxv := uint32(1)<<to - 1
	out := make([]byte, 0, len(data)*int(from)/int(to)+1)
	for _, b := range data {
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

// bech32Encode returns the lowercase encoding. The checksum covers the lowercase
// HRP, so a caller that wants age's uppercase form uppercases the result.
func bech32Encode(hrp string, data []byte) (string, error) {
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

func bech32Decode(s string) (hrp string, data []byte, err error) {
	if strings.ToLower(s) != s && strings.ToUpper(s) != s {
		return "", nil, fmt.Errorf("bech32: mixed case")
	}
	lower := strings.ToLower(s)
	// BIP-173: the separator is the last "1", because the human-readable part
	// may contain one.
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
