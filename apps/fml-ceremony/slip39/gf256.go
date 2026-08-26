package slip39

// GF(2^8) arithmetic modulo the AES polynomial x^8 + x^4 + x^3 + x + 1 (0x11b),
// which is the field SLIP-0039 splits every byte of the secret in.
//
// No log/antilog tables. Two reasons, one of them found the hard way upstream:
// a table indexed by share bytes is a variable-time lookup over secret
// material, and a table built by repeatedly doubling is simply wrong, because
// 0x02 is not a generator of this field (0x03 is) — wrong in the worst way,
// since it round-trips perfectly through its own splitter and fails every
// official vector. The loop below is branchless, table-free, and pinned against
// FIPS-197 section 4.2 in the tests.

// gmul multiplies in GF(2^8). Every step is arithmetic on masks derived from
// the operands rather than a branch or an index, so the running time does not
// depend on the values.
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

// ginv returns a^-1 = a^254. The exponent is a compile-time constant, so the
// branch below is on the exponent's bits and not on a, and 0 maps to 0.
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

// interpolate evaluates the Lagrange interpolation of the given points at x,
// one instance of the scheme per byte position. Subtraction in GF(2^8) is XOR,
// which is why the differences below are written with ^.
//
// The caller guarantees the xs are pairwise distinct and that x is not among
// them: SLIP-39 evaluates at 254 and 255 while share indices are four bits, so
// no denominator here can be zero.
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
