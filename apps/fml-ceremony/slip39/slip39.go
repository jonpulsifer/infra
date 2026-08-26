// Package slip39 implements SLIP-0039 share encoding and recovery for the
// ceremony's four secrets: the master seed at 3-of-5 and each branch secret at
// 2-of-3, four separate share sets rather than groups of one secret.
//
// SLIP-39 over raw Shamir because raw Shamir emitting hex has no error
// detection, no set identity and no threshold metadata — one misread character
// on a steel plate silently yields a wrong secret. The decisive property is not
// the checksum though: SLIP-39 has independent recovery tooling that outlives
// this repository, and against the operator-death threat a share format only
// our own binary can read is not a backup.
package slip39

import (
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/sha256"
	"crypto/subtle"
	_ "embed"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"strings"
	"sync"
)

const (
	// radix is the wordlist size; every word carries exactly 10 bits.
	radix     = 1024
	radixBits = 10
	// idBits and the field widths below are the 40-bit metadata prefix.
	idBits       = 15
	checksumLen  = 3 // words
	metadataBits = 40
	digestLen    = 4
	// The secret sits at f(255) and the digest at f(254). Member and group
	// indices are four bits, so neither index can collide with a share's own x.
	secretIndex = 255
	digestIndex = 254
	maxShares   = 16
	minStrength = 128 // bits
	// baseIterations is per Feistel round; four rounds give SLIP-39's stated
	// 10000 << e total.
	baseIterations = 2500
)

//go:embed wordlist.txt
var wordlistFile string

// wordlistSHA256 pins the vendored list by content. A different list would
// produce mnemonics that decode to different bytes while still looking valid.
const wordlistSHA256 = "bcc4555340332d169718aed8bf31dd9d5248cb7da6e5d355140ef4f1e601eec3"

type lists struct {
	words []string
	index map[string]int
}

var wordlist = sync.OnceValues(func() (*lists, error) {
	sum := sha256.Sum256([]byte(wordlistFile))
	if got := hex.EncodeToString(sum[:]); got != wordlistSHA256 {
		return nil, fmt.Errorf("slip39: wordlist SHA-256 is %s, want %s", got, wordlistSHA256)
	}
	words := strings.Split(strings.TrimSuffix(wordlistFile, "\n"), "\n")
	if len(words) != radix {
		return nil, fmt.Errorf("slip39: wordlist has %d entries, want %d", len(words), radix)
	}
	idx := make(map[string]int, radix)
	for i, w := range words {
		idx[w] = i
	}
	return &lists{words: words, index: idx}, nil
})

// rs1024Polymod is the Reed-Solomon code over GF(1024) from SLIP-0039, verbatim
// from the specification's Python snippet. Three checksum words guarantee
// detection of any error affecting at most three words of a share, which is the
// maximum a three-symbol MDS checksum can guarantee.
func rs1024Polymod(values []int) uint32 {
	gen := [10]uint32{0xe0e040, 0x1c1c080, 0x3838100, 0x7070200, 0xe0e0009,
		0x1c0c2412, 0x38086c24, 0x3090fc48, 0x21b1f890, 0x3f3f120}
	chk := uint32(1)
	for _, v := range values {
		b := chk >> 20
		chk = (chk&0xfffff)<<10 ^ uint32(v)
		for i := 0; i < 10; i++ {
			if (b>>i)&1 == 1 {
				chk ^= gen[i]
			}
		}
	}
	return chk
}

// customization binds the checksum to the share's own extendable flag, so an
// ext bit flip invalidates the whole share rather than producing a differently
// parsed one.
func customization(ext bool) []int {
	s := "shamir"
	if ext {
		s = "shamir_extendable"
	}
	out := make([]int, len(s))
	for i := 0; i < len(s); i++ {
		out[i] = int(s[i])
	}
	return out
}

func rs1024Verify(ext bool, data []int) bool {
	return rs1024Polymod(append(customization(ext), data...)) == 1
}

func rs1024Create(ext bool, data []int) []int {
	values := append(customization(ext), data...)
	polymod := rs1024Polymod(append(values, 0, 0, 0)) ^ 1
	out := make([]int, checksumLen)
	for i := 0; i < checksumLen; i++ {
		out[i] = int(polymod>>(radixBits*(2-i))) & (radix - 1)
	}
	return out
}

// bitCursor walks a share's 10-bit words as a big-endian bit string. The fields
// are not byte-aligned, so every read and write goes through here.
type bitCursor struct {
	words []int
	pos   int
}

func (c *bitCursor) read(n int) uint32 {
	var v uint32
	for i := 0; i < n; i++ {
		p := c.pos + i
		v = v<<1 | uint32(c.words[p/radixBits]>>(radixBits-1-p%radixBits))&1
	}
	c.pos += n
	return v
}

func (c *bitCursor) write(v uint32, n int) {
	for i := n - 1; i >= 0; i-- {
		p := c.pos
		for p/radixBits >= len(c.words) {
			c.words = append(c.words, 0)
		}
		c.words[p/radixBits] |= int(v>>i&1) << (radixBits - 1 - p%radixBits)
		c.pos++
	}
}

type share struct {
	id    uint16
	ext   bool
	e     uint8
	group uint8 // GI
	gt    uint8 // GT, the actual threshold
	gc    uint8 // G, the actual count
	index uint8 // I
	t     uint8 // T, the actual member threshold
	value []byte
}

// checkCommonFields is the "all shares MUST have the same ..." list from
// SLIP-0039's combine procedure. It is shared with Recover so a plate from a
// foreign set is named as such instead of surviving to the polynomial check
// with a vaguer message.
func checkCommonFields(shares []share) error {
	first := shares[0]
	for _, s := range shares[1:] {
		switch {
		case s.id != first.id:
			return fmt.Errorf("slip39: mismatched identifier — these shares are from different sets")
		case s.ext != first.ext:
			return fmt.Errorf("slip39: mismatched extendable flag")
		case s.e != first.e:
			return fmt.Errorf("slip39: mismatched iteration exponent")
		case s.gt != first.gt:
			return fmt.Errorf("slip39: mismatched group threshold")
		case s.gc != first.gc:
			return fmt.Errorf("slip39: mismatched group count")
		case len(s.value) != len(first.value):
			return fmt.Errorf("slip39: mismatched share length")
		}
	}
	return nil
}

func decodeShare(mnemonic string) (share, error) {
	wl, err := wordlist()
	if err != nil {
		return share{}, err
	}
	words := strings.Fields(mnemonic)
	data := make([]int, len(words))
	for i, w := range words {
		idx, ok := wl.index[strings.ToLower(w)]
		if !ok {
			return share{}, fmt.Errorf("slip39: %q is not in the wordlist", w)
		}
		data[i] = idx
	}
	// Every length rule below is a hard reject rather than a best effort: a
	// share of the wrong length cannot be repaired into the right one, and the
	// specification forbids proposing a correction.
	if len(data)*radixBits < metadataBits+minStrength+checksumLen*radixBits {
		return share{}, fmt.Errorf("slip39: mnemonic has %d words, too short to carry a share", len(data))
	}
	if !rs1024Verify(peekExt(data), data) {
		return share{}, fmt.Errorf("slip39: invalid checksum")
	}
	c := &bitCursor{words: data}
	var s share
	s.id = uint16(c.read(idBits))
	s.ext = c.read(1) == 1
	s.e = uint8(c.read(4))
	s.group = uint8(c.read(4))
	s.gt = uint8(c.read(4)) + 1
	s.gc = uint8(c.read(4)) + 1
	s.index = uint8(c.read(4))
	s.t = uint8(c.read(4)) + 1

	paddedBits := len(data)*radixBits - metadataBits - checksumLen*radixBits
	padding := paddedBits % 16
	if padding > 8 {
		return share{}, fmt.Errorf("slip39: mnemonic has %d words, which is not a valid share length", len(data))
	}
	if c.read(padding) != 0 {
		return share{}, fmt.Errorf("slip39: non-zero padding")
	}
	valueBits := paddedBits - padding
	if valueBits < minStrength {
		return share{}, fmt.Errorf("slip39: share value is %d bits, minimum %d", valueBits, minStrength)
	}
	s.value = make([]byte, valueBits/8)
	for i := range s.value {
		s.value[i] = byte(c.read(8))
	}
	return s, nil
}

// peekExt reads the extendable flag before the checksum is verified, because
// the flag selects which customization string the checksum is computed under.
func peekExt(data []int) bool {
	c := &bitCursor{words: data, pos: idBits}
	return c.read(1) == 1
}

func encodeShare(s share) (string, error) {
	wl, err := wordlist()
	if err != nil {
		return "", err
	}
	valueBits := len(s.value) * 8
	padding := (radixBits - valueBits%radixBits) % radixBits
	c := &bitCursor{}
	c.write(uint32(s.id), idBits)
	c.write(boolBit(s.ext), 1)
	c.write(uint32(s.e), 4)
	c.write(uint32(s.group), 4)
	c.write(uint32(s.gt-1), 4)
	c.write(uint32(s.gc-1), 4)
	c.write(uint32(s.index), 4)
	c.write(uint32(s.t-1), 4)
	c.write(0, padding)
	for _, b := range s.value {
		c.write(uint32(b), 8)
	}
	data := append(c.words, rs1024Create(s.ext, c.words)...)
	words := make([]string, len(data))
	for i, d := range data {
		words[i] = wl.words[d]
	}
	return strings.Join(words, " "), nil
}

func boolBit(b bool) uint32 {
	if b {
		return 1
	}
	return 0
}

// roundFunction is SLIP-39's Feistel round: PBKDF2-HMAC-SHA256 with the round
// number prepended to the passphrase as one byte. For an empty passphrase the
// password is the single byte 0x00 for round 0, which looks wrong and is right.
func roundFunction(i byte, passphrase string, e uint8, salt, r []byte) ([]byte, error) {
	return pbkdf2.Key(sha256.New, string([]byte{i})+passphrase,
		append(append([]byte{}, salt...), r...), baseIterations<<e, len(r))
}

// saltPrefix binds the identifier into the encryption only when ext = 0. With
// ext = 1 the EMS is a pure function of the secret, which is what makes the
// deterministic split below reproducible.
func saltPrefix(id uint16, ext bool) []byte {
	if ext {
		return nil
	}
	return binary.BigEndian.AppendUint16([]byte("shamir"), id)
}

// crypt runs the four-round Feistel network. Encryption uses rounds 0..3 and
// decryption 3..0; nothing else differs, so both directions share this code and
// cannot drift apart.
func crypt(ms []byte, passphrase string, e uint8, id uint16, ext bool, forward bool) ([]byte, error) {
	half := len(ms) / 2
	l := append([]byte{}, ms[:half]...)
	r := append([]byte{}, ms[half:]...)
	salt := saltPrefix(id, ext)
	for n := 0; n < 4; n++ {
		i := byte(n)
		if !forward {
			i = byte(3 - n)
		}
		f, err := roundFunction(i, passphrase, e, salt, r)
		if err != nil {
			return nil, err
		}
		next := make([]byte, half)
		subtle.XORBytes(next, l, f)
		l, r = r, next
	}
	return append(r, l...), nil
}

// splitSecret is SLIP-0039's SplitSecret with the randomness supplied by the
// caller rather than drawn from the OS.
//
// Stock SplitSecret is randomised, which means two splits of the same secret
// produce sets that are not interchangeable and a single lost plate cannot be
// re-cut without collecting and destroying every survivor. Deriving the
// randomness from the secret makes replacing one plate a matter of regenerating
// and stamping one plate. The price, stated plainly: below threshold this stops
// being information-theoretically secure and becomes computationally secure at
// 2^256, because T-1 shares plus this published rule determine the secret by
// search. Everything else guarding the master — HKDF, Ed25519, the tree — is
// computational already.
//
// Only generation changes. The recovery path is untouched, and the output is
// ordinary SLIP-39 that any conforming implementation reads.
func splitSecret(threshold, count int, secret, random []byte) ([][]byte, error) {
	if threshold <= 0 || threshold > count || count > maxShares {
		return nil, fmt.Errorf("slip39: %d-of-%d is out of range", threshold, count)
	}
	if len(secret)*8 < minStrength || len(secret)%2 != 0 {
		return nil, fmt.Errorf("slip39: secret is %d octets, want at least %d and a whole number of 16-bit units", len(secret), minStrength/8)
	}
	if threshold == 1 {
		out := make([][]byte, count)
		for i := range out {
			out[i] = append([]byte{}, secret...)
		}
		return out, nil
	}
	n := len(secret)
	want := (n - digestLen) + (threshold-2)*n
	if len(random) != want {
		return nil, fmt.Errorf("slip39: %d random octets supplied, need %d", len(random), want)
	}
	r := random[:n-digestLen]
	rest := random[n-digestLen:]

	mac := hmac.New(sha256.New, r)
	mac.Write(secret)
	digest := append(mac.Sum(nil)[:digestLen], r...)

	xs := make([]byte, 0, threshold)
	ys := make([][]byte, 0, threshold)
	out := make([][]byte, count)
	for i := 0; i < threshold-2; i++ {
		y := append([]byte{}, rest[i*n:(i+1)*n]...)
		out[i] = y
		xs = append(xs, byte(i))
		ys = append(ys, y)
	}
	xs = append(xs, digestIndex, secretIndex)
	ys = append(ys, digest, secret)
	for i := threshold - 2; i < count; i++ {
		out[i] = interpolate(byte(i), xs, ys)
	}
	return out, nil
}

// recoverSecret is SLIP-0039's RecoverSecret. The digest at f(254) is what
// catches shares that are individually valid but do not belong together; the
// checksum on each share cannot see that.
func recoverSecret(threshold int, xs []byte, ys [][]byte) ([]byte, error) {
	if threshold == 1 {
		return append([]byte{}, ys[0]...), nil
	}
	secret := interpolate(secretIndex, xs, ys)
	digest := interpolate(digestIndex, xs, ys)
	r := digest[digestLen:]
	mac := hmac.New(sha256.New, r)
	mac.Write(secret)
	if !hmac.Equal(mac.Sum(nil)[:digestLen], digest[:digestLen]) {
		return nil, fmt.Errorf("slip39: invalid digest — these shares do not belong together")
	}
	return secret, nil
}

const (
	// splitSalt and the info below frame the HKDF stream that derandomises
	// generation. They are versioned so that changing the framing is a visible
	// change rather than a silently different share set for the same secret.
	splitSalt = "fml-slip39-split-v1"
)

// checkSplitParams rejects a share set that would be malformed or pointless.
func checkSplitParams(secret []byte, threshold, count int) error {
	if threshold <= 0 || threshold > count || count > maxShares {
		return fmt.Errorf("slip39: %d-of-%d is out of range (1..%d)", threshold, count, maxShares)
	}
	if threshold == 1 && count > 1 {
		return fmt.Errorf("slip39: 1-of-%d hands the whole secret to every holder", count)
	}
	if len(secret)*8 < minStrength || len(secret)%2 != 0 {
		return fmt.Errorf("slip39: secret is %d octets, want at least %d and a whole number of 16-bit units", len(secret), minStrength/8)
	}
	return nil
}

// splitStream is the derandomised generation stream. Split and Identifier both
// read it so the identifier a caller reports can never drift from the one the
// shares actually carry -- the defect this function exists to make impossible.
func splitStream(secret []byte, threshold, count int) ([]byte, error) {
	n := len(secret)
	need := 2 + (n - digestLen) + max(threshold-2, 0)*n
	return hkdf.Key(sha256.New, secret, []byte(splitSalt),
		fmt.Sprintf("%d-of-%d", threshold, count), need)
}

// identifierFrom reads the 15-bit identifier off the front of the stream. The
// top bit of the two-octet draw is discarded, not folded in, so the identifier
// stays a straight read.
func identifierFrom(stream []byte) uint16 {
	return binary.BigEndian.Uint16(stream[:2]) & (1<<idBits - 1)
}

// Identifier is the identifier the shares of this set carry, without generating
// them. A holder reads it off the first two words of any plate to confirm the
// plate belongs to this ceremony, and a transcript publishes it for exactly that
// check -- so it must be derived here rather than transcribed by hand.
func Identifier(secret []byte, threshold, count int) (uint16, error) {
	if err := checkSplitParams(secret, threshold, count); err != nil {
		return 0, err
	}
	stream, err := splitStream(secret, threshold, count)
	if err != nil {
		return 0, err
	}
	return identifierFrom(stream), nil
}

// Split encodes secret as count mnemonics, any threshold of which recover it.
// Single group, GT = 1, G = 1: SLIP-0039 says a plain T-of-N scheme SHOULD be
// built that way rather than as N groups of 1-of-1, so that a recovering party
// can tell from any single share that a single-level scheme was used.
//
// The output is a pure function of (secret, threshold, count). Two runs produce
// the same share set, so one lost plate is replaced by regenerating and
// stamping that plate alone.
func Split(secret []byte, threshold, count int, passphrase string) ([]string, error) {
	if err := checkSplitParams(secret, threshold, count); err != nil {
		return nil, err
	}
	// The specification requires printable ASCII. Enforced on generation only:
	// refusing it on recovery would block a share set made by another tool,
	// which is the interoperability this format was chosen for.
	for i := 0; i < len(passphrase); i++ {
		if passphrase[i] < 32 || passphrase[i] > 126 {
			return nil, fmt.Errorf("slip39: passphrase must be printable ASCII")
		}
	}
	stream, err := splitStream(secret, threshold, count)
	if err != nil {
		return nil, err
	}
	id := identifierFrom(stream)
	const ext = true // required for newly created shares

	ems, err := crypt(secret, passphrase, 0, id, ext, true)
	if err != nil {
		return nil, err
	}
	values, err := splitSecret(threshold, count, ems, stream[2:])
	if err != nil {
		return nil, err
	}
	out := make([]string, count)
	for i, v := range values {
		out[i], err = encodeShare(share{
			id: id, ext: ext, e: 0,
			group: 0, gt: 1, gc: 1,
			index: uint8(i), t: uint8(threshold),
			value: v,
		})
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}

// Combine recovers the secret. It implements the full two-level scheme even
// though this repository only ever generates single-group sets, because the
// official test vectors are the validation checklist and half of them are
// group-structure failures.
func Combine(mnemonics []string, passphrase string) ([]byte, error) {
	if len(mnemonics) == 0 {
		return nil, fmt.Errorf("slip39: no mnemonics")
	}
	shares := make([]share, 0, len(mnemonics))
	for _, m := range mnemonics {
		s, err := decodeShare(m)
		if err != nil {
			return nil, err
		}
		shares = append(shares, s)
	}
	first := shares[0]
	if err := checkCommonFields(shares); err != nil {
		return nil, err
	}
	if first.gc < first.gt {
		return nil, fmt.Errorf("slip39: group count %d is below group threshold %d", first.gc, first.gt)
	}

	type group struct {
		t   uint8
		xs  []byte
		ys  [][]byte
		set map[uint8]bool
	}
	groups := map[uint8]*group{}
	order := []uint8{}
	for _, s := range shares {
		g, ok := groups[s.group]
		if !ok {
			g = &group{t: s.t, set: map[uint8]bool{}}
			groups[s.group] = g
			order = append(order, s.group)
		}
		if g.t != s.t {
			return nil, fmt.Errorf("slip39: mismatched member threshold within group %d", s.group)
		}
		if g.set[s.index] {
			return nil, fmt.Errorf("slip39: duplicate member index %d in group %d", s.index, s.group)
		}
		g.set[s.index] = true
		g.xs = append(g.xs, s.index)
		g.ys = append(g.ys, s.value)
	}
	if len(groups) != int(first.gt) {
		return nil, fmt.Errorf("slip39: %d group(s) supplied, need exactly %d", len(groups), first.gt)
	}

	gxs := make([]byte, 0, len(order))
	gys := make([][]byte, 0, len(order))
	for _, gi := range order {
		g := groups[gi]
		if len(g.xs) != int(g.t) {
			return nil, fmt.Errorf("slip39: group %d has %d share(s), needs exactly %d", gi, len(g.xs), g.t)
		}
		v, err := recoverSecret(int(g.t), g.xs, g.ys)
		if err != nil {
			return nil, err
		}
		gxs = append(gxs, gi)
		gys = append(gys, v)
	}
	ems, err := recoverSecret(int(first.gt), gxs, gys)
	if err != nil {
		return nil, err
	}
	return crypt(ems, passphrase, first.e, first.id, first.ext, false)
}

// Recover is Combine for the room the ceremony actually happens in: five people
// turn up with five plates, not with exactly three.
//
// Combine is deliberately the specification's primitive and rejects a surplus —
// SLIP-0039 requires each group to supply exactly its threshold — which is
// correct for a decoder and wrong for a recovery procedure. Recover takes the
// threshold from each group, and then uses every surplus share as a check
// rather than discarding it: a share that does not lie on the recovered
// polynomial is a mis-stamped or misfiled plate, which RS1024 cannot see
// because that plate is internally perfectly valid.
func Recover(mnemonics []string, passphrase string) ([]byte, error) {
	if len(mnemonics) == 0 {
		return nil, fmt.Errorf("slip39: no mnemonics")
	}
	shares := make([]share, 0, len(mnemonics))
	for _, m := range mnemonics {
		s, err := decodeShare(m)
		if err != nil {
			return nil, err
		}
		shares = append(shares, s)
	}
	if err := checkCommonFields(shares); err != nil {
		return nil, err
	}
	// The same plate handed over twice is one plate. Dropping the duplicate
	// here rather than letting Combine reject it matters during a recovery:
	// two copies of plate 1 plus plate 2 is a valid 2-of-3 quorum, and the
	// operator should not be sent hunting for a "duplicate member index" when
	// the room actually holds what it needs.
	byGroup := map[uint8][]int{}
	var order []uint8
	seen := map[[2]uint8]bool{}
	for i, s := range shares {
		key := [2]uint8{s.group, s.index}
		if seen[key] {
			continue
		}
		seen[key] = true
		if _, ok := byGroup[s.group]; !ok {
			order = append(order, s.group)
		}
		byGroup[s.group] = append(byGroup[s.group], i)
	}
	gt := int(shares[0].gt)
	if len(order) < gt {
		return nil, fmt.Errorf("slip39: %d group(s) supplied, need at least %d", len(order), gt)
	}
	var quorum []string
	var surplus []share
	for gi, group := range order {
		members := byGroup[group]
		t := int(shares[members[0]].t)
		if gi >= gt {
			// A group beyond the group threshold contributes nothing that can
			// be checked without recovering it too, and recovering it needs its
			// own quorum. Refuse rather than ignore.
			return nil, fmt.Errorf("slip39: %d group(s) supplied, need exactly %d", len(order), gt)
		}
		if len(members) < t {
			return nil, fmt.Errorf("slip39: group %d has %d share(s), needs %d", group, len(members), t)
		}
		for _, i := range members[:t] {
			quorum = append(quorum, mnemonics[i])
		}
		for _, i := range members[t:] {
			surplus = append(surplus, shares[i])
		}
	}
	secret, err := Combine(quorum, passphrase)
	if err != nil {
		return nil, err
	}
	if len(surplus) > 0 {
		if err := checkSurplus(shares, surplus); err != nil {
			return nil, err
		}
	}
	return secret, nil
}

// checkSurplus re-evaluates each group's polynomial at every surplus share's
// index and compares. The threshold shares already fix the polynomial, so a
// mismatch means the surplus plate belongs to a different set or was
// transcribed wrong in a way its own checksum accepts.
func checkSurplus(all []share, surplus []share) error {
	quorumOf := map[uint8]struct {
		xs []byte
		ys [][]byte
		t  int
	}{}
	for _, s := range all {
		q := quorumOf[s.group]
		q.t = int(s.t)
		if len(q.xs) < q.t {
			q.xs = append(q.xs, s.index)
			q.ys = append(q.ys, s.value)
		}
		quorumOf[s.group] = q
	}
	for _, s := range surplus {
		q := quorumOf[s.group]
		if q.t == 1 {
			if subtle.ConstantTimeCompare(s.value, q.ys[0]) != 1 {
				return fmt.Errorf("slip39: share %d of group %d disagrees with the others", s.index, s.group)
			}
			continue
		}
		want := interpolate(s.index, q.xs, q.ys)
		if subtle.ConstantTimeCompare(want, s.value) != 1 {
			return fmt.Errorf("slip39: share %d of group %d does not lie on the same polynomial as the rest — wrong or mis-stamped plate", s.index, s.group)
		}
	}
	return nil
}
