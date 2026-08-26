package entropy

import (
	"bytes"
	"crypto/sha256"
	"math"
	"slices"
	"strings"
	"testing"
)

// value is a deterministic stand-in for a source's contribution.
func value(n int) []byte {
	sum := sha256.Sum256([]byte{byte(n), byte(n >> 8), byte(n >> 16), byte(n >> 24)})
	return sum[:]
}

// xorMix and naiveConcat are the two constructions this package rejects. They
// are here so the tests can show the failures actually happening rather than
// asserting an absence against nothing.
func xorMix(sources []Source) [SeedLen]byte {
	var out [SeedLen]byte
	for _, s := range sources {
		for i := range out {
			out[i] ^= s.Bytes[i%len(s.Bytes)]
		}
	}
	return out
}

func naiveConcat(sources []Source) [SeedLen]byte {
	var ikm []byte
	for _, s := range sources {
		ikm = append(ikm, s.Bytes...)
	}
	return sha256.Sum256(ikm)
}

func mustMix(t *testing.T, sources []Source) [SeedLen]byte {
	t.Helper()
	out, err := Mix(sources)
	if err != nil {
		t.Fatalf("Mix: %v", err)
	}
	return [SeedLen]byte(out)
}

// TestAdversarialPeerCannotReduceEntropy is the claim the source set rests on:
// one honest source is enough, whatever the others do. For each adversarial
// strategy the honest source ranges over `trials` values and every one must
// still produce a distinct seed -- no strategy collapses two honest inputs onto
// one output, which is min-entropy preservation stated on a finite domain.
//
// The copycat row also runs XOR, where the same attack destroys everything.
func TestAdversarialPeerCannotReduceEntropy(t *testing.T) {
	const trials = 4096

	strategies := map[string]func(honest []byte) []byte{
		// A stuck or hostile peripheral emitting a constant.
		"constant": func([]byte) []byte { return bytes.Repeat([]byte{0x01}, SeedLen) },
		// A contribution chosen in advance, before seeing anything.
		"precommitted": func([]byte) []byte { return value(0x7777) },
		// The interesting one: a source that observes its peer and echoes it.
		"copycat": func(honest []byte) []byte { return bytes.Clone(honest) },
		// The same, aimed at a specific seed the adversary wants.
		"targeting": func(honest []byte) []byte {
			target, out := value(0xdead), make([]byte, SeedLen)
			for i := range out {
				out[i] = honest[i] ^ target[i]
			}
			return out
		},
	}

	for name, adversary := range strategies {
		t.Run(name, func(t *testing.T) {
			seeds := make(map[[SeedLen]byte]bool, trials)
			for i := range trials {
				honest := Source{Label: "kernel", Bytes: value(i)}
				peer := Source{Label: "flipper", Bytes: adversary(honest.Bytes)}
				seeds[mustMix(t, []Source{honest, peer})] = true
			}
			if len(seeds) != trials {
				t.Fatalf("%d distinct seeds from %d honest inputs, want all distinct", len(seeds), trials)
			}
		})
	}

	// XOR under the copycat: every honest input cancels to the same seed, so
	// the master would carry zero entropy no matter how good the kernel is.
	xorSeeds := make(map[[SeedLen]byte]bool)
	for i := range trials {
		honest := Source{Label: "kernel", Bytes: value(i)}
		xorSeeds[xorMix([]Source{honest, {Label: "flipper", Bytes: bytes.Clone(honest.Bytes)}})] = true
	}
	if len(xorSeeds) != 1 {
		t.Fatalf("xor baseline: %d distinct seeds, expected the copycat to collapse all %d", len(xorSeeds), trials)
	}

	// XOR under targeting: the last contributor picks the seed outright.
	honest := Source{Label: "kernel", Bytes: value(1)}
	target := value(0xdead)
	forged := xorMix([]Source{honest, {Label: "flipper", Bytes: strategies["targeting"](honest.Bytes)}})
	if !bytes.Equal(forged[:], target) {
		t.Fatal("xor baseline: expected the adaptive forgery to land")
	}
}

// TestFramingIsInjective pins the length prefixes. Appending contributions raw
// lets two different source tuples mix to one seed, which would make the
// transcript's per-source claims unfalsifiable.
func TestFramingIsInjective(t *testing.T) {
	split1 := []Source{{Label: "kernel", Bytes: []byte("xy")}, {Label: "dice-d6", Bytes: []byte("z")}}
	split2 := []Source{{Label: "kernel", Bytes: []byte("x")}, {Label: "dice-d6", Bytes: []byte("yz")}}

	if naiveConcat(split1) != naiveConcat(split2) {
		t.Fatal("baseline: expected raw concatenation to collide on these splits")
	}
	if mustMix(t, split1) == mustMix(t, split2) {
		t.Fatal("framed mix collided on an ambiguous split")
	}

	// Adding a source must move the seed even if its bytes duplicate a peer's.
	extended := append(slices.Clone(split1), Source{Label: "flipper", Bytes: []byte("z")})
	if mustMix(t, split1) == mustMix(t, extended) {
		t.Fatal("adding a source did not change the seed")
	}
}

// TestMixRejectsSilentFailures covers the failure modes that would otherwise
// leave a seed resting on fewer sources than the transcript names.
func TestMixRejectsSilentFailures(t *testing.T) {
	ok := Source{Label: "kernel", Bytes: value(1)}
	cases := map[string][]Source{
		"single source":  {ok},
		"no sources":     nil,
		"empty label":    {ok, {Label: "", Bytes: value(2)}},
		"duplicate name": {ok, {Label: "kernel", Bytes: value(2)}},
		"zero bytes":     {ok, {Label: "flipper", Bytes: nil}},
		"all zero":       {ok, {Label: "flipper", Bytes: make([]byte, SeedLen)}},
		"all ff":         {ok, {Label: "flipper", Bytes: bytes.Repeat([]byte{0xff}, SeedLen)}},
	}
	for name, sources := range cases {
		if _, err := Mix(sources); err == nil {
			t.Errorf("%s: Mix accepted it", name)
		}
	}
}

// TestWitnessIsNotTheMixInput is the transcript's safety property. The digests
// the transcript publishes must be a different computation from the bytes the
// extractor consumed -- otherwise publishing every source's witness publishes
// the master seed. This fails if someone "simplifies" Mix to hash each source
// first and extract over the hashes.
func TestWitnessIsNotTheMixInput(t *testing.T) {
	sources := []Source{
		{Label: "kernel", Bytes: value(1)},
		{Label: "flipper", Bytes: value(2)},
		{Label: "dice-d6", Bytes: value(3)},
	}
	witnessed := make([]Source, len(sources))
	for i, s := range sources {
		if bytes.Equal(Witness(s), s.Bytes) {
			t.Fatalf("%s: witness is the contribution", s.Label)
		}
		witnessed[i] = Source{Label: s.Label, Bytes: Witness(s)}
	}
	if mustMix(t, sources) == mustMix(t, witnessed) {
		t.Fatal("the published witnesses reconstruct the mix input")
	}
}

func TestDice(t *testing.T) {
	if bits := math.Log2(6) * DiceRolls; bits < 256 {
		t.Fatalf("%d rolls carry %.1f bits, want at least 256", DiceRolls, bits)
	}
	if bits := math.Log2(6) * (DiceRolls - 1); bits >= 256 {
		t.Fatalf("%d rolls would already do, DiceRolls is not minimal", DiceRolls-1)
	}

	good := strings.Repeat("123456", 16) + "1234"
	src, tally, err := Dice(good)
	if err != nil {
		t.Fatalf("Dice: %v", err)
	}
	if string(src.Bytes) != good {
		t.Fatal("Dice re-encoded the rolls")
	}
	if sum := tally[0] + tally[1] + tally[2] + tally[3] + tally[4] + tally[5]; sum != DiceRolls {
		t.Fatalf("tally sums to %d, want %d", sum, DiceRolls)
	}
	if tally[0] != 17 || tally[5] != 16 {
		t.Fatalf("tally = %v, want 17 ones and 16 sixes", tally)
	}

	bad := map[string]string{
		"short":        strings.Repeat("1", DiceRolls-1),
		"long":         strings.Repeat("1", DiceRolls+1),
		"missing face": strings.Repeat("12345", 20),
		"not a digit":  strings.Repeat("123456", 16) + "123x",
	}
	for name, rolls := range bad {
		if _, _, err := Dice(rolls); err == nil {
			t.Errorf("%s: Dice accepted it", name)
		}
	}
}
