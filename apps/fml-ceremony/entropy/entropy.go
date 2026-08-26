// Package entropy mixes the independent contributions collected during the
// ceremony into the 256-bit master seed that SPEC.md derives everything from.
//
// The mixer runs exactly once and is never replayed. The master survives on
// SLIP-39 shards, not by re-mixing, so nothing in the recovery path depends on
// this file. That is why it sits outside the derivation spec's surface, needs
// no second implementation, and can afford to abort rather than cope.
package entropy

import (
	"crypto/hkdf"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
)

// SeedLen is the master seed length. SPEC.md section 2: exactly 32 octets.
const SeedLen = 32

// MinSources is two because a mix of one has nothing to degrade to. The whole
// argument for this construction is that a compromised source is survivable,
// and with a single source it is not.
const MinSources = 2

// DiceRolls is the first roll count whose min-entropy clears 256 bits:
// 100 * log2(6) = 258.49. See TestDice.
const DiceRolls = 100

// WitnessFloorBits is the min-entropy below which publishing a source's digest
// hands an attacker a brute-force target instead of proving participation.
// 128 bits is the usual infeasibility line. Every v1 source clears 256, which
// is not luck: the source set was chosen so that every member is safe to
// publish a digest of. A source below this floor is recorded as present with
// no digest, and is a reason to ask why it is a source at all.
const WitnessFloorBits = 128

const (
	// mixSalt is HKDF-Extract's salt. Fixed and public: RFC 5869 salts are not
	// secret, and a per-ceremony salt would have to be recorded somewhere to be
	// meaningful, which is one more thing to get wrong for no gain.
	mixSalt = "fml-entropy-mix-v1"
	// mixInfo separates this expansion from every other HKDF in the estate and
	// carries the mixing version. Changing the framing below obliges a bump.
	mixInfo = "fml/master/v1"
	// witnessTag keeps the transcript digest a different computation from the
	// mixing input. Without it, a transcript that publishes every source's
	// digest publishes the extractor's input, and therefore the master seed.
	witnessTag = "fml-entropy-witness-v1"
)

// Source is one contribution: Label is the name the transcript uses, Bytes is
// the material exactly as collected. Nothing normalises, pads or re-encodes it.
type Source struct {
	Label string
	Bytes []byte
}

// appendFrame length-prefixes a contribution so that concatenating sources is
// injective. Appending raw bytes is not: {"xy", "z"} and {"x", "yz"} produce
// the same input, so the transcript's statement of which source supplied what
// would not be a statement about what was actually extracted.
func appendFrame(dst []byte, s Source) []byte {
	dst = binary.BigEndian.AppendUint32(dst, uint32(len(s.Label)))
	dst = append(dst, s.Label...)
	dst = binary.BigEndian.AppendUint32(dst, uint32(len(s.Bytes)))
	return append(dst, s.Bytes...)
}

// Mix returns the master seed. Every declared source must deliver bytes: a
// source that fails on ceremony day is dropped from the declared set out loud,
// never skipped quietly, or the transcript claims three sources fed a seed that
// two did.
//
// Extract over the framed concatenation, not XOR of the contributions. XOR
// lets whoever contributes last choose the output, and lets a source that
// echoes another source cancel it to zero; see the tests, which demonstrate
// both against this construction and find neither.
func Mix(sources []Source) ([]byte, error) {
	if len(sources) < MinSources {
		return nil, fmt.Errorf("entropy: %d sources, need at least %d", len(sources), MinSources)
	}
	var ikm []byte
	seen := make(map[string]bool, len(sources))
	for _, s := range sources {
		if s.Label == "" {
			return nil, errors.New("entropy: source with no label")
		}
		if seen[s.Label] {
			return nil, fmt.Errorf("entropy: duplicate source label %q", s.Label)
		}
		seen[s.Label] = true
		if err := check(s); err != nil {
			return nil, err
		}
		ikm = appendFrame(ikm, s)
	}
	return hkdf.Key(sha256.New, ikm, []byte(mixSalt), mixInfo, SeedLen)
}

// check refuses the two ways a source fails without saying so: a short read
// that would let the ceremony continue on fewer sources than it declared, and a
// dead peripheral returning a constant. Neither is an entropy test -- a weak
// source passes both. They catch a broken wire, and the constant test costs
// about 2^-255 bits.
func check(s Source) error {
	if len(s.Bytes) == 0 {
		return fmt.Errorf("entropy: source %q contributed nothing", s.Label)
	}
	if constant(s.Bytes, 0x00) || constant(s.Bytes, 0xff) {
		return fmt.Errorf("entropy: source %q returned %d constant bytes", s.Label, len(s.Bytes))
	}
	return nil
}

func constant(b []byte, v byte) bool {
	for _, c := range b {
		if c != v {
			return false
		}
	}
	return true
}

// Witness is what the transcript publishes for a source: evidence it took part,
// without the contribution. Safe only above WitnessFloorBits of min-entropy.
func Witness(s Source) []byte {
	sum := sha256.Sum256(appendFrame([]byte(witnessTag), s))
	return sum[:]
}

// Dice validates a d6 sequence and returns it alongside the face tally the
// operator compares against the marks they made on paper while rolling. That
// comparison is the entry check: six small numbers, computed independently on
// both sides, catching an omitted line, a duplicated line or a substitution.
// It does not catch a transposition, and does not need to -- a reordered
// sequence is a different but equally good seed, and the seed is kept by
// sharding it, never by re-deriving it from the rolls.
//
// The rolls are mixed as the ASCII digits that were typed. There is no base-6
// to binary conversion: the extractor consumes bytes and is indifferent to how
// densely they are encoded, and hand-rolled bignum base conversion is a bug
// generator that buys nothing here.
func Dice(rolls string) (Source, [6]int, error) {
	var tally [6]int
	if len(rolls) != DiceRolls {
		return Source{}, tally, fmt.Errorf("entropy: %d rolls, want exactly %d", len(rolls), DiceRolls)
	}
	for i := 0; i < len(rolls); i++ {
		c := rolls[i]
		if c < '1' || c > '6' {
			return Source{}, tally, fmt.Errorf("entropy: roll %d is %q, want a digit 1-6", i+1, c)
		}
		tally[c-'1']++
	}
	// A face that never came up in 100 fair rolls has probability about 7e-8;
	// a worksheet line entered short happens far more often than that.
	// Conditioning the seed on this test costs roughly 1e-7 bits.
	for face, n := range tally {
		if n == 0 {
			return Source{}, tally, fmt.Errorf("entropy: face %d never appeared in %d rolls, re-check the entry", face+1, DiceRolls)
		}
	}
	return Source{Label: "dice-d6", Bytes: []byte(rolls)}, tally, nil
}
