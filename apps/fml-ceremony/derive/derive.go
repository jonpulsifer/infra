package derive

import (
	"crypto/hkdf"
	"crypto/sha256"
	"errors"
	"fmt"
)

// SeedLen is the master seed and branch secret length. SPEC.md sections 2 and
// 5.1: both are exactly 32 octets.
const SeedLen = 32

// The two salts of SPEC.md section 5. The levels already differ in their IKM,
// so these are not load-bearing for separation. They exist so an implementation
// that confuses the levels produces visibly different bytes rather than a
// plausible-looking wrong answer.
const (
	saltMaster = "fml-derive-master"
	saltBranch = "fml-derive-branch"
)

// Branch derives a branch secret from the master seed (SPEC.md 5.1).
//
// It deliberately does not reject an all-zero or all-0xff master: that check
// belongs to the ceremony, which knows a constant seed means entropy collection
// failed, and not to the library, whose published test vector A is the all-zero
// master. CheckCeremonyMaster is the ceremony's half.
func Branch(masterSeed []byte, branchPath string) ([]byte, error) {
	if len(masterSeed) != SeedLen {
		return nil, fmt.Errorf("derive: master seed is %d octets, want %d", len(masterSeed), SeedLen)
	}
	if err := CheckBranchPath(branchPath); err != nil {
		return nil, err
	}
	prk, err := branchPRK(masterSeed)
	if err != nil {
		return nil, err
	}
	return hkdf.Expand(sha256.New, prk, branchPath, SeedLen)
}

// Leaf derives leaf key material from a branch secret (SPEC.md 5.2). info is
// the full absolute leaf path including the branch prefix that already selected
// the branch secret: binding the branch in twice costs nothing and means a leaf
// name reused under two branches cannot collide even under a level-1 bug.
//
// length is the leaf's declared L. RFC 5869 does not mix L into the expansion
// input, so the L=32 output is a literal prefix of the L=64 output; a leaf's key
// type, and therefore its L, is fixed by the tree declaration for exactly that
// reason (SPEC.md 4.3).
func Leaf(branchSecret []byte, branchPath, leafPath string, length int) ([]byte, error) {
	if len(branchSecret) != SeedLen {
		return nil, fmt.Errorf("derive: branch secret is %d octets, want %d", len(branchSecret), SeedLen)
	}
	if err := CheckLeafPath(branchPath, leafPath); err != nil {
		return nil, err
	}
	if length <= 0 {
		return nil, fmt.Errorf("derive: leaf %q length %d", leafPath, length)
	}
	prk, err := leafPRK(branchSecret)
	if err != nil {
		return nil, err
	}
	return hkdf.Expand(sha256.New, prk, leafPath, length)
}

// branchPRK and leafPRK exist so the intermediate PRKs SPEC.md section 11
// publishes can be checked directly, localising a disagreement between two
// implementations to a level instead of merely declaring one wrong.
//
// Go's hkdf.Extract takes (secret, salt) — the reverse of RFC 5869's prose
// ordering of HKDF-Extract(salt, IKM). Swapping them yields a well-formed wrong
// answer with no error, which is why it is spelled out here and pinned in the
// tests rather than left to the reader.
func branchPRK(masterSeed []byte) ([]byte, error) {
	return hkdf.Extract(sha256.New, masterSeed, []byte(saltMaster))
}

func leafPRK(branchSecret []byte) ([]byte, error) {
	return hkdf.Extract(sha256.New, branchSecret, []byte(saltBranch))
}

// CheckCeremonyMaster refuses the two constants that mean entropy collection
// failed rather than that the seed happens to be unlikely. SPEC.md section 9
// puts this on the ceremony, not on Branch.
func CheckCeremonyMaster(masterSeed []byte) error {
	if len(masterSeed) != SeedLen {
		return fmt.Errorf("derive: master seed is %d octets, want %d", len(masterSeed), SeedLen)
	}
	if constant(masterSeed, 0x00) || constant(masterSeed, 0xff) {
		return errors.New("derive: master seed is a constant — entropy collection failed")
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
