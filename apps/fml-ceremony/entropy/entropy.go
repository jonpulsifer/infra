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

// SeedLen is the master seed length in octets.
const SeedLen = 32

// With one source, a compromised source is not survivable.
const MinSources = 2

// DiceRolls is the first roll count whose min-entropy clears 256 bits:
// 100 * log2(6) = 258.49. See TestDice.
const DiceRolls = 100

// Below this min-entropy, a published source digest is a brute-force target.
// 128 bits is the usual infeasibility line.
const WitnessFloorBits = 128

const (
	// Fixed and public: RFC 5869 salts are not secret.
	mixSalt = "fml-entropy-mix-v1"
	// Carries the mixing version; a change to the framing needs a bump.
	mixInfo = "fml/master/v1"
	// Domain-separates the witness from the mixing input, so publishing every
	// witness never reveals the extractor's input.
	witnessTag = "fml-entropy-witness-v1"
)

// Source is one contribution. Label is its transcript name; Bytes are kept as
// collected, never normalised or re-encoded.
type Source struct {
	Label string
	Bytes []byte
}

// Length prefixes make the concatenation injective: unframed, {"xy", "z"} and
// {"x", "yz"} would be one input.
func appendFrame(dst []byte, s Source) []byte {
	dst = binary.BigEndian.AppendUint32(dst, uint32(len(s.Label)))
	dst = append(dst, s.Label...)
	dst = binary.BigEndian.AppendUint32(dst, uint32(len(s.Bytes)))
	return append(dst, s.Bytes...)
}

// Mix extracts the master seed from the framed sources. XOR would let the last
// contributor choose the output and an echoing source cancel another.
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

// check catches a broken wire: an empty read, or a dead peripheral returning a
// constant. A weak source passes both.
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

// Witness is the transcript's evidence that a source took part, without its
// bytes. Safe only above WitnessFloorBits of min-entropy.
func Witness(s Source) []byte {
	sum := sha256.Sum256(appendFrame([]byte(witnessTag), s))
	return sum[:]
}

// Dice validates a d6 sequence and returns the face tally the operator checks
// against the paper marks. The rolls are mixed as the typed ASCII digits.
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
	// A face missing from 100 fair rolls has probability about 7e-8, far below
	// that of a worksheet line entered short.
	for face, n := range tally {
		if n == 0 {
			return Source{}, tally, fmt.Errorf("entropy: face %d never appeared in %d rolls, re-check the entry", face+1, DiceRolls)
		}
	}
	return Source{Label: "dice-d6", Bytes: []byte(rolls)}, tally, nil
}
