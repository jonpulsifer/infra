package slip39

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// TestFIPS197 pins GF(2^8) multiplication against FIPS-197 section 4.2 before
// anything touches a share. A field built on the wrong generator round-trips
// perfectly through its own splitter and fails every official vector, so this
// runs first and localises that failure to eight lines of arithmetic.
func TestFIPS197(t *testing.T) {
	if got := gmul(0x57, 0x83); got != 0xc1 {
		t.Errorf("0x57 * 0x83 = %#x, want 0xc1", got)
	}
	if got := gmul(0x57, 0x13); got != 0xfe {
		t.Errorf("0x57 * 0x13 = %#x, want 0xfe", got)
	}
	for a := 1; a < 256; a++ {
		if got := gmul(byte(a), ginv(byte(a))); got != 1 {
			t.Fatalf("%#x * inv(%#x) = %#x", a, a, got)
		}
	}
	if ginv(0) != 0 {
		t.Error("inv(0) is not 0")
	}
}

func TestWordlistIdentity(t *testing.T) {
	wl, err := wordlist()
	if err != nil {
		t.Fatal(err)
	}
	if len(wl.words) != radix {
		t.Fatalf("%d words", len(wl.words))
	}
	// Every four-letter prefix is unique, which is what makes recording only
	// the first four letters on a steel plate lossless and reversible.
	seen := map[string]string{}
	for _, w := range wl.words {
		if len(w) < 4 || len(w) > 8 {
			t.Errorf("%q is %d letters, want 4-8", w, len(w))
		}
		p := w[:4]
		if prev, ok := seen[p]; ok {
			t.Errorf("prefix %q is shared by %q and %q", p, prev, w)
		}
		seen[p] = w
	}
}

type vector struct {
	description string
	mnemonics   []string
	secret      string
}

func loadVectors(t *testing.T) []vector {
	t.Helper()
	raw, err := os.ReadFile("../testdata/slip39-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var quads [][]any
	if err := json.Unmarshal(raw, &quads); err != nil {
		t.Fatal(err)
	}
	out := make([]vector, 0, len(quads))
	for _, q := range quads {
		v := vector{description: q[0].(string), secret: q[2].(string)}
		for _, m := range q[1].([]any) {
			v.mnemonics = append(v.mnemonics, m.(string))
		}
		out = append(out, v)
	}
	return out
}

// TestOfficialVectors runs all 45 quadruples from the SLIP-0039 reference
// implementation. Fifteen must recover their stated secret; the other thirty
// carry an empty secret and are the combine-time validation checklist written
// out — bad checksum, non-zero padding, differing id, differing iteration
// exponent, mismatched thresholds and counts, duplicate member indices,
// insufficient groups or members, invalid digest, short mnemonic, invalid
// master-secret length.
func TestOfficialVectors(t *testing.T) {
	vs := loadVectors(t)
	if len(vs) != 45 {
		t.Fatalf("%d vectors, want 45", len(vs))
	}
	var valid, invalid int
	for _, v := range vs {
		got, err := Combine(v.mnemonics, "TREZOR")
		if v.secret == "" {
			invalid++
			if err == nil {
				t.Errorf("%s: recovered %x from a must-fail vector", v.description, got)
			}
			continue
		}
		valid++
		if err != nil {
			t.Errorf("%s: %v", v.description, err)
			continue
		}
		if hex.EncodeToString(got) != v.secret {
			t.Errorf("%s: recovered %x, want %s", v.description, got, v.secret)
		}
	}
	if valid != 15 || invalid != 30 {
		t.Fatalf("ran %d valid and %d must-fail vectors, want 15 and 30", valid, invalid)
	}
}

// TestEmptyPassphraseRoundTrip covers the gap the official vectors leave. Every
// valid vector uses the passphrase "TREZOR"; the empty passphrase this ceremony
// uses appears in none of them, and neither does a 3-of-5 set at any
// passphrase, extendable or not.
func TestEmptyPassphraseRoundTrip(t *testing.T) {
	secret, err := hex.DecodeString("2d85dabefa504eefea7740977b1f9110daf404cc24422896a209b41eca970218")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ threshold, count int }{{3, 5}, {2, 3}, {1, 1}, {16, 16}, {2, 16}} {
		shares, err := Split(secret, tc.threshold, tc.count, "")
		if err != nil {
			t.Fatalf("%d-of-%d: %v", tc.threshold, tc.count, err)
		}
		if len(shares) != tc.count {
			t.Fatalf("%d-of-%d produced %d shares", tc.threshold, tc.count, len(shares))
		}
		for _, s := range shares {
			if n := len(strings.Fields(s)); n != 33 {
				t.Errorf("%d-of-%d: a 256-bit share is %d words, want 33", tc.threshold, tc.count, n)
			}
		}
		got, err := Combine(shares[:tc.threshold], "")
		if err != nil {
			t.Fatalf("%d-of-%d: %v", tc.threshold, tc.count, err)
		}
		if hex.EncodeToString(got) != hex.EncodeToString(secret) {
			t.Errorf("%d-of-%d recovered %x", tc.threshold, tc.count, got)
		}
	}
}

// TestSplitIsDeterministic is the property that makes replacing one lost plate
// a matter of regenerating and stamping that plate, instead of reconstituting
// the secret, re-splitting, and physically collecting and destroying every
// surviving plate from every holder.
func TestSplitIsDeterministic(t *testing.T) {
	secret := make([]byte, 32)
	for i := range secret {
		secret[i] = byte(i)
	}
	a, err := Split(secret, 3, 5, "")
	if err != nil {
		t.Fatal(err)
	}
	b, err := Split(secret, 3, 5, "")
	if err != nil {
		t.Fatal(err)
	}
	for i := range a {
		if a[i] != b[i] {
			t.Fatalf("share %d differs between runs", i)
		}
	}
	// A different threshold or count is a different set, and mixing the two
	// must abort rather than silently interpolate garbage.
	c, err := Split(secret, 2, 3, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Combine([]string{a[0], c[0]}, ""); err == nil {
		t.Error("shares from two different sets combined")
	}
}

func TestSplitRejection(t *testing.T) {
	secret := make([]byte, 32)
	for _, tc := range []struct {
		name             string
		secret           []byte
		threshold, count int
		passphrase       string
	}{
		{"threshold above count", secret, 4, 3, ""},
		{"zero threshold", secret, 0, 3, ""},
		{"too many shares", secret, 2, 17, ""},
		{"1-of-N hands over the secret", secret, 1, 3, ""},
		{"secret too short", make([]byte, 15), 2, 3, ""},
		{"odd secret length", make([]byte, 17), 2, 3, ""},
		{"non-ASCII passphrase", secret, 2, 3, "café"},
	} {
		if _, err := Split(tc.secret, tc.threshold, tc.count, tc.passphrase); err == nil {
			t.Errorf("%s: accepted", tc.name)
		}
	}
}

func TestCombineRejection(t *testing.T) {
	secret := make([]byte, 32)
	secret[0] = 1
	shares, err := Split(secret, 3, 5, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name string
		in   []string
	}{
		{"none", nil},
		{"below threshold", shares[:2]},
		{"one share of a 3-of-5", shares[:1]},
		{"duplicate share", []string{shares[0], shares[0], shares[1]}},
		{"unknown word", []string{strings.Replace(shares[0], strings.Fields(shares[0])[0], "notaword", 1), shares[1], shares[2]}},
	} {
		if got, err := Combine(tc.in, ""); err == nil {
			t.Errorf("%s: recovered %x", tc.name, got)
		}
	}
	// A wrong passphrase does not fail — SLIP-39 has no way to verify one — it
	// silently returns a different secret. That is the specification's
	// behaviour, and it is the reason this ceremony uses no passphrase at all.
	other, err := Combine(shares[:3], "TREZOR")
	if err != nil {
		t.Fatalf("a wrong passphrase errored instead of returning other bytes: %v", err)
	}
	if hex.EncodeToString(other) == hex.EncodeToString(secret) {
		t.Error("the passphrase had no effect")
	}
}

// TestRecoverSurplus is the difference between the specification's decoder and
// a recovery procedure: five people with five plates must not be told no, and
// a plate that does not belong must not be silently ignored.
func TestRecoverSurplus(t *testing.T) {
	secret := make([]byte, 32)
	secret[31] = 7
	shares, err := Split(secret, 3, 5, "")
	if err != nil {
		t.Fatal(err)
	}
	for n := 3; n <= 5; n++ {
		got, err := Recover(shares[:n], "")
		if err != nil {
			t.Fatalf("%d plates: %v", n, err)
		}
		if hex.EncodeToString(got) != hex.EncodeToString(secret) {
			t.Fatalf("%d plates recovered %x", n, got)
		}
	}
	if _, err := Recover(shares[:2], ""); err == nil {
		t.Error("two plates of a 3-of-5 recovered")
	}
	// A surplus plate from a foreign set is internally valid and passes RS1024.
	// The identifier names it.
	other := make([]byte, 32)
	other[0] = 9
	foreign, err := Split(other, 3, 5, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Recover(append(append([]string{}, shares[:3]...), foreign[3]), ""); err == nil {
		t.Error("a foreign surplus plate was accepted")
	}

	// The case only the polynomial check can see: a plate from the right set,
	// with the right identifier and a valid checksum, whose value is wrong.
	// This is a mis-stamped or mis-transcribed plate, and it is the reason
	// surplus shares are checked rather than dropped.
	bad, err := decodeShare(shares[3])
	if err != nil {
		t.Fatal(err)
	}
	bad.value[0] ^= 0x01
	restamped, err := encodeShare(bad)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decodeShare(restamped); err != nil {
		t.Fatalf("the re-stamped plate is not internally valid: %v", err)
	}
	if _, err := Recover(append(append([]string{}, shares[:3]...), restamped), ""); err == nil {
		t.Error("a mis-stamped surplus plate from the right set was accepted")
	}
}

// TestIdentifierMatchesShares is the guard for the defect that put three
// invented identifiers into a published transcript: a caller reporting the
// identifier separately from the shares can report one the plates do not carry.
// Identifier and Split must read the same stream, so every share of every set
// must carry exactly what Identifier says.
func TestIdentifierMatchesShares(t *testing.T) {
	secrets := [][]byte{
		make([]byte, 32),
		bytes.Repeat([]byte{0xa5}, 32),
		bytes.Repeat([]byte{0xff}, 16),
	}
	for _, secret := range secrets {
		for _, tc := range []struct{ threshold, count int }{{2, 3}, {3, 5}, {1, 1}, {5, 16}} {
			want, err := Identifier(secret, tc.threshold, tc.count)
			if err != nil {
				t.Fatalf("Identifier(%d-of-%d): %v", tc.threshold, tc.count, err)
			}
			ms, err := Split(secret, tc.threshold, tc.count, "")
			if err != nil {
				t.Fatalf("Split(%d-of-%d): %v", tc.threshold, tc.count, err)
			}
			for i, m := range ms {
				got, err := decodeShare(m)
				if err != nil {
					t.Fatalf("decodeShare(share %d): %v", i, err)
				}
				if got.id != want {
					t.Errorf("%d-of-%d share %d carries id %d, Identifier says %d",
						tc.threshold, tc.count, i, got.id, want)
				}
			}
		}
	}
}

// TestIdentifierRejectsBadParams: Identifier must refuse exactly what Split
// refuses, or a caller can publish an identifier for a set that cannot exist.
func TestIdentifierRejectsBadParams(t *testing.T) {
	secret := make([]byte, 32)
	for _, tc := range []struct{ threshold, count int }{{0, 3}, {4, 3}, {2, 17}, {1, 3}} {
		if _, err := Identifier(secret, tc.threshold, tc.count); err == nil {
			t.Errorf("Identifier(%d-of-%d) accepted a set Split rejects", tc.threshold, tc.count)
		}
	}
	if _, err := Identifier(make([]byte, 15), 2, 3); err == nil {
		t.Error("Identifier accepted a 15-octet secret")
	}
}

// TestRecoverToleratesDuplicatePlates: a holder turning up with two copies of
// the same plate must not consume a quorum slot. Before the fix, plate1 twice
// plus plate2 filled a 2-of-3 quorum with two copies of plate1 and aborted on
// "duplicate member index" while the room actually held what it needed.
func TestRecoverToleratesDuplicatePlates(t *testing.T) {
	secret := bytes.Repeat([]byte{0x3c}, 32)
	ms, err := Split(secret, 2, 3, "")
	if err != nil {
		t.Fatal(err)
	}
	got, err := Recover([]string{ms[0], ms[0], ms[1]}, "")
	if err != nil {
		t.Fatalf("a duplicated plate plus a distinct one should recover: %v", err)
	}
	if !bytes.Equal(got, secret) {
		t.Error("recovered the wrong secret")
	}
	// A duplicate must not manufacture a quorum that does not exist.
	if _, err := Recover([]string{ms[0], ms[0]}, ""); err == nil {
		t.Error("one plate handed over twice reached a 2-of-3 threshold")
	}
}
