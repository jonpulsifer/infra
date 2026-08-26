package slip39_test

import (
	"encoding/hex"
	"math/bits"
	"strings"
	"testing"

	"github.com/jonpulsifer/infra/apps/fml-ceremony/derive"
	"github.com/jonpulsifer/infra/apps/fml-ceremony/slip39"
)

// The share plan of SPEC.md section 6.1 and 8, as arithmetic rather than prose:
// four separate secrets, four separate share sets. The master is 3-of-5 held by
// people; each minted branch is 2-of-3 held at sites. Holders and sites are
// disjoint — nobody holds both a master plate and a branch plate — which is
// what makes the two-tier quorum mean anything.
//
// Names here are roles, not the roster. Who actually holds which plate is
// private and lives nowhere in this repository.
type shareSet struct {
	name      string
	threshold int
	holders   []string
	secret    []byte
	mnemonics []string
}

func buildPlan(t *testing.T) []*shareSet {
	t.Helper()
	master, err := hex.DecodeString("2d85dabefa504eefea7740977b1f9110daf404cc24422896a209b41eca970218")
	if err != nil {
		t.Fatal(err)
	}
	plan := []*shareSet{{
		name:      "master",
		threshold: 3,
		holders:   []string{"person-1", "person-2", "person-3", "person-4", "person-5"},
		secret:    master,
	}}
	for _, branch := range derive.MintedBranches {
		secret, err := derive.Branch(master, branch)
		if err != nil {
			t.Fatal(err)
		}
		plan = append(plan, &shareSet{
			name:      branch,
			threshold: 2,
			holders:   []string{"site-home-safe", "site-offsite", "site-bank-box"},
			secret:    secret,
		})
	}
	for _, s := range plan {
		s.mnemonics, err = slip39.Split(s.secret, s.threshold, len(s.holders), "")
		if err != nil {
			t.Fatalf("%s: %v", s.name, err)
		}
	}
	return plan
}

// TestQuorumSafety enumerates every subset of every set's holders — all 48
// distinct outcomes across the three sets — and asserts two properties by
// actually running the recovery, not by reasoning about it:
//
//  1. No unintended coalition reconstructs anything. A set is recoverable
//     exactly when the coalition holds at least that set's threshold, and every
//     sub-threshold attempt aborts.
//  2. No single person and no single site loss makes anything unrecoverable.
//
// This is a static combinatorial property, which is why it is a table test and
// not a model checker.
func TestQuorumSafety(t *testing.T) {
	plan := buildPlan(t)

	total := 0
	for _, s := range plan {
		total += len(s.holders)
	}
	if total != 11 {
		t.Fatalf("the plan has %d plates, expected 11", total)
	}

	// The three sets never interact: a coalition's outcome for one set is a
	// function of that set's mask alone, so enumerating the 2^11 cross-product
	// would re-read these same 48 answers and assert nothing further. The
	// cross-set property is TestNoCrossSetCoalition's job, not this loop's.
	type outcome struct {
		ok     bool
		secret string
	}
	recovered := make([]map[int]outcome, len(plan))
	for i, s := range plan {
		recovered[i] = map[int]outcome{}
		for mask := 0; mask < 1<<len(s.holders); mask++ {
			var held []string
			for j := range s.holders {
				if mask&(1<<j) != 0 {
					held = append(held, s.mnemonics[j])
				}
			}
			// Recover, not Combine: the property under test is "this coalition
			// gets the secret", and a coalition of four turning up with four
			// plates is a coalition of four. Combine is the specification's
			// exact-threshold primitive and refuses the surplus.
			got, err := slip39.Recover(held, "")
			recovered[i][mask] = outcome{ok: err == nil, secret: hex.EncodeToString(got)}

			// Property 1, asserted where the outcome is produced.
			want := bits.OnesCount(uint(mask)) >= s.threshold
			if (err == nil) != want {
				t.Fatalf("%s: %d of %d plates recovered=%v, want %v (mask %0*b)",
					s.name, bits.OnesCount(uint(mask)), len(s.holders), err == nil, want,
					len(s.holders), mask)
			}
			if err == nil && hex.EncodeToString(got) != hex.EncodeToString(s.secret) {
				t.Fatalf("%s: %d plates recovered the wrong secret",
					s.name, bits.OnesCount(uint(mask)))
			}
		}
	}

	// Property 2, stated as the loss of any single plate holder.
	for i, s := range plan {
		for j, holder := range s.holders {
			full := 1<<len(s.holders) - 1
			if out := recovered[i][full&^(1<<j)]; !out.ok {
				t.Errorf("%s: losing %s makes the set unrecoverable", s.name, holder)
			}
		}
	}

	// A branch is recoverable a second way: 3-of-5 people rebuild the master
	// and re-derive it. So losing an entire site costs nothing at all, and
	// losing two of a branch's three sites is still survivable.
	for _, s := range plan[1:] {
		for mask := 0; mask < 1<<len(s.holders); mask++ {
			if bits.OnesCount(uint(mask)) >= s.threshold {
				continue
			}
			got, err := derive.Branch(plan[0].secret, s.name)
			if err != nil {
				t.Fatal(err)
			}
			if hex.EncodeToString(got) != hex.EncodeToString(s.secret) {
				t.Fatalf("%s: the master does not re-derive it", s.name)
			}
		}
	}
}

// TestNoCrossSetCoalition is the other half of "no unintended coalition":
// holding a threshold of one set must not help with any other. Every branch
// site together must not reach the master, and the two branches' sites together
// must not reach each other's secret.
func TestNoCrossSetCoalition(t *testing.T) {
	plan := buildPlan(t)

	for i, a := range plan {
		for j, b := range plan {
			if i == j {
				continue
			}
			// Mixing whole sets must abort on the identifier, and mixing a
			// threshold of one set with any plates of another must not produce
			// the other's secret.
			mixed := append(append([]string{}, a.mnemonics...), b.mnemonics...)
			if _, err := slip39.Combine(mixed, ""); err == nil {
				t.Errorf("%s + %s combined", a.name, b.name)
			}
			got, err := slip39.Combine(a.mnemonics[:a.threshold], "")
			if err != nil {
				t.Fatal(err)
			}
			if hex.EncodeToString(got) == hex.EncodeToString(b.secret) {
				t.Errorf("%s's quorum recovered %s's secret", a.name, b.name)
			}
		}
	}

	// A branch-secret holder derives their own leaves and nobody else's. This
	// is the two-tier quorum's whole point, so it is asserted rather than
	// assumed.
	for _, s := range plan[1:] {
		for _, d := range derive.V1Tree {
			m, err := derive.MintLeaf(s.secret, s.name, d.Path)
			if d.Branch == s.name {
				if err != nil {
					t.Errorf("%s cannot mint its own leaf %s: %v", s.name, d.Path, err)
				}
				continue
			}
			// The descent check refuses outright rather than returning a
			// well-formed key nobody can reproduce.
			if err == nil {
				t.Errorf("%s minted %s, a leaf of another branch: %+v", s.name, d.Path, m.Leaf)
			}
		}
	}

	// Reserved names mint nothing at all, from any secret.
	for _, r := range derive.ReservedBranches {
		if _, err := derive.Declared(r + "/v1/anything/v1"); err == nil {
			t.Errorf("%s minted something", r)
		}
	}
}

// TestPlateCapacity is the number to check before buying any steel plate: a
// 256-bit secret gives 33-word shares, not 24 and not 20, which disqualifies
// most seed plates on the market.
func TestPlateCapacity(t *testing.T) {
	plan := buildPlan(t)
	plates := 0
	for _, s := range plan {
		for _, m := range s.mnemonics {
			plates++
			words := strings.Fields(m)
			if len(words) != 33 {
				t.Fatalf("%s: %d words per plate", s.name, len(words))
			}
			for _, w := range words {
				if len(w) < 4 {
					t.Fatalf("%q is under four letters", w)
				}
			}
		}
	}
	if plates != 11 {
		t.Fatalf("%d plates, want 11", plates)
	}
}
