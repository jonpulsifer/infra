package slip39

// GF(2^8) modulo the AES polynomial 0x11b, the field SLIP-0039 uses. There are
// no log tables, because a lookup indexed by secret bytes is variable-time.

// gmul uses masks in place of branches and indexes, so its running time does not
// depend on the operands.
func gmul(a, b byte) byte {
	var p byte
	for i := 0; i < 8; i++ {
		p ^= a & -(b & 1)
		hi := -(a >> 7)
		a <<= 1
		a ^= 0x1b & hi
		b >>= 1
	}
	return p
}

// ginv returns a^254, the inverse, and maps 0 to 0. The branch is on the constant
// exponent's bits, never on a.
func ginv(a byte) byte {
	r := byte(1)
	for _, bit := range [8]byte{1, 1, 1, 1, 1, 1, 1, 0} {
		r = gmul(r, r)
		if bit == 1 {
			r = gmul(r, a)
		}
	}
	return r
}

// Lagrange interpolation at x, per byte position; subtraction is XOR. Callers
// keep xs distinct and x outside them, so no denominator is zero.
func interpolate(x byte, xs []byte, ys [][]byte) []byte {
	n := len(ys[0])
	out := make([]byte, n)
	for i := range xs {
		num, den := byte(1), byte(1)
		for j := range xs {
			if i == j {
				continue
			}
			num = gmul(num, x^xs[j])
			den = gmul(den, xs[i]^xs[j])
		}
		coeff := gmul(num, ginv(den))
		for k := 0; k < n; k++ {
			out[k] ^= gmul(ys[i][k], coeff)
		}
	}
	return out
}
