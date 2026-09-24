package derive

import (
	"crypto/hkdf"
	"crypto/sha256"
	"errors"
	"fmt"
)

// SeedLen is the master seed and branch secret length in octets.
const SeedLen = 32

// The levels already differ in their IKM. The salts make an implementation that
// confuses the levels produce visibly wrong bytes.
const (
	saltMaster = "fml-derive-master"
	saltBranch = "fml-derive-branch"
)

// Branch derives a branch secret from the master seed. It accepts a constant
// master, which test vector A uses; CheckCeremonyMaster rejects one.
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

// Leaf derives leaf key material from a branch secret. HKDF output at L=32 is a
// prefix of the L=64 output, so the tree declaration fixes each leaf's length.
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
	// The full path binds the branch again, so a leaf name reused under two
	// branches cannot collide.
	return hkdf.Expand(sha256.New, prk, leafPath, length)
}

// Go's hkdf.Extract takes (secret, salt), the reverse of RFC 5869's
// HKDF-Extract(salt, IKM). Swapped arguments give a wrong answer and no error.
func branchPRK(masterSeed []byte) ([]byte, error) {
	return hkdf.Extract(sha256.New, masterSeed, []byte(saltMaster))
}

func leafPRK(branchSecret []byte) ([]byte, error) {
	return hkdf.Extract(sha256.New, branchSecret, []byte(saltBranch))
}

// CheckCeremonyMaster refuses the all-zero and all-0xff seeds, which mean entropy
// collection failed.
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
