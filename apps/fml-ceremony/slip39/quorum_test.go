package slip39_test

import (
	"encoding/hex"
	"math/bits"
	"strings"
	"testing"

	"github.com/jonpulsifer/infra/apps/fml-ceremony/derive"
	"github.com/jonpulsifer/infra/apps/fml-ceremony/slip39"
)

// The master is 3-of-5 held by people; each minted branch is 2-of-3 held at
// sites. Names are roles; the real roster is private and never goes in this repo.
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

// Every subset of a set's holders recovers exactly when it meets the threshold,
// and no single holder's loss makes a set unrecoverable.
func TestQuorumSafety(t *testing.T) {
	plan := buildPlan(t)

	total := 0
	for _, s := range plan {
		total += len(s.holders)
	}
	if total != 11 {
		t.Fatalf("the plan has %d plates, expected 11", total)
	}

	// An outcome depends only on its own set's mask, so the 2^11 cross-product
	// adds nothing. TestNoCrossSetCoalition covers mixed sets.
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
			// Recover, because Combine refuses plates beyond the threshold.
			got, err := slip39.Recover(held, "")
			recovered[i][mask] = outcome{ok: err == nil, secret: hex.EncodeToString(got)}

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

	for i, s := range plan {
		for j, holder := range s.holders {
			full := 1<<len(s.holders) - 1
			if out := recovered[i][full&^(1<<j)]; !out.ok {
				t.Errorf("%s: losing %s makes the set unrecoverable", s.name, holder)
			}
		}
	}

	// Below a branch's threshold, 3-of-5 people can still rebuild the master and
	// re-derive the branch.
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

// A threshold of one set must not help with any other.
func TestNoCrossSetCoalition(t *testing.T) {
	plan := buildPlan(t)

	for i, a := range plan {
		for j, b := range plan {
			if i == j {
				continue
			}
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

	// A branch-secret holder derives their own leaves and nobody else's.
	for _, s := range plan[1:] {
		for _, d := range derive.V1Tree {
			m, err := derive.MintLeaf(s.secret, s.name, d.Path)
			if d.Branch == s.name {
				if err != nil {
					t.Errorf("%s cannot mint its own leaf %s: %v", s.name, d.Path, err)
				}
				continue
			}
			if err == nil {
				t.Errorf("%s minted %s, a leaf of another branch: %+v", s.name, d.Path, m.Leaf)
			}
		}
	}

	for _, r := range derive.ReservedBranches {
		if _, err := derive.Declared(r + "/v1/anything/v1"); err == nil {
			t.Errorf("%s minted something", r)
		}
	}
}

// A 256-bit secret gives 33-word shares, more than most seed plates hold.
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
