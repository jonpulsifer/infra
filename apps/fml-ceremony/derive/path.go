// Package derive implements SPEC.md: the labelled HKDF tree that turns one
// 256-bit master seed into every key Folly Mountain Laboratories holds.
//
// The tree is exactly three levels — master, branch, leaf — and derivation is
// chained, so a branch-secret holder derives their own leaves without the
// master. That is the two-tier quorum written as arithmetic.
package derive

import (
	"fmt"
	"strings"
)

// Sanity bounds: HKDF info has no practical limit, but a longer path is a bug in
// whatever generated it.
const (
	MaxPathBytes      = 128
	MaxPathComponents = 16
)

// Root is the mandatory first component.
const Root = "fml"

// SplitPath validates a path and returns its components. It never normalises,
// because normalising maps two distinct intents onto one key.
func SplitPath(path string) ([]string, error) {
	if path == "" {
		return nil, fmt.Errorf("derive: empty path")
	}
	if len(path) > MaxPathBytes {
		return nil, fmt.Errorf("derive: path %q is %d octets, limit %d", path, len(path), MaxPathBytes)
	}
	// A leading, trailing or doubled "/" becomes an empty component, which
	// checkComponent rejects.
	parts := strings.Split(path, "/")
	if len(parts) > MaxPathComponents {
		return nil, fmt.Errorf("derive: path %q has %d components, limit %d", path, len(parts), MaxPathComponents)
	}
	for i, c := range parts {
		if err := checkComponent(c); err != nil {
			return nil, fmt.Errorf("derive: path %q component %d: %w", path, i+1, err)
		}
	}
	if parts[0] != Root {
		return nil, fmt.Errorf("derive: path %q does not start at %q", path, Root)
	}
	if !isVersion(parts[len(parts)-1]) {
		return nil, fmt.Errorf("derive: path %q does not end in a version component", path)
	}
	return parts, nil
}

// The charset excludes "/", so joining components is injective and two
// distinct component lists always get distinct HKDF info.
func checkComponent(c string) error {
	if c == "" {
		return fmt.Errorf("empty")
	}
	for i := 0; i < len(c); i++ {
		b := c[i]
		switch {
		case b >= 'a' && b <= 'z':
		case i > 0 && (b >= '0' && b <= '9' || b == '-'):
		default:
			return fmt.Errorf("%q is not [a-z][a-z0-9-]*", c)
		}
	}
	return nil
}

// isVersion matches "v" nonzero-digit *digit. A leading zero would give one
// version two spellings and two keys.
func isVersion(c string) bool {
	if len(c) < 2 || c[0] != 'v' || c[1] < '1' || c[1] > '9' {
		return false
	}
	for i := 2; i < len(c); i++ {
		if c[i] < '0' || c[i] > '9' {
			return false
		}
	}
	return true
}

// CheckBranchPath accepts fml/<branch>/<version>.
func CheckBranchPath(path string) error {
	parts, err := SplitPath(path)
	if err != nil {
		return err
	}
	if len(parts) != 3 {
		return fmt.Errorf("derive: branch path %q has %d components, want 3", path, len(parts))
	}
	return nil
}

// CheckLeafPath requires at least two components below branchPath. A branch
// secret does not identify its branch, so the descent check stops cross-branch keys.
func CheckLeafPath(branchPath, leafPath string) error {
	if err := CheckBranchPath(branchPath); err != nil {
		return err
	}
	parts, err := SplitPath(leafPath)
	if err != nil {
		return err
	}
	if len(parts) < 5 {
		return fmt.Errorf("derive: leaf path %q has %d components, want at least 5", leafPath, len(parts))
	}
	if !strings.HasPrefix(leafPath, branchPath+"/") {
		return fmt.Errorf("derive: leaf path %q does not descend from branch %q", leafPath, branchPath)
	}
	return nil
}
