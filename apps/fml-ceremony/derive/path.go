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

// Path limits from SPEC.md section 3.1. Both are sanity bounds rather than
// cryptographic ones: HKDF's info has no practical length limit, but a path
// that long is a bug in whatever generated it.
const (
	MaxPathBytes      = 128
	MaxPathComponents = 16
)

// Root is the mandatory first component. A path that does not start here is
// not part of this tree and is rejected rather than adopted.
const Root = "fml"

// SplitPath validates a path against SPEC.md section 3.1 and returns its
// components. It rejects; it never normalises. Sanitising silently maps two
// distinct operator intents onto one key, and the operator finds out years
// later when a key they expected to be distinct is not.
func SplitPath(path string) ([]string, error) {
	if path == "" {
		return nil, fmt.Errorf("derive: empty path")
	}
	if len(path) > MaxPathBytes {
		return nil, fmt.Errorf("derive: path %q is %d octets, limit %d", path, len(path), MaxPathBytes)
	}
	// Splitting on the separator turns a leading, trailing or doubled "/" into
	// an empty component, which the charset check below rejects. One code path
	// covers all three.
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

// checkComponent enforces component = lowercase-letter *( lowercase-letter /
// digit / "-" ). The charset is what makes component-list to string injective:
// "/" cannot appear inside a component, so splitting the joined string always
// recovers the list it was built from. Two distinct paths therefore always have
// distinct HKDF info, and the separator-injection bug where ["a/b","c"] and
// ["a","b/c"] derive the same key cannot exist.
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

// isVersion reports whether c matches "v" nonzero-digit *digit. v0 and v01 are
// not versions: a leading zero would give one version two spellings and two
// distinct keys.
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

// CheckBranchPath accepts exactly fml/<branch>/<version>.
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

// CheckLeafPath accepts a branch path followed by at least two more components,
// and requires the leaf to be a strict descendant of branchPath.
//
// The descent check is not decoration. A 32-octet branch secret carries no
// evidence of which branch it is, so without it the holder of fml/wallet/v1
// can derive a perfectly well-formed key at an fml/infra/... path that nobody
// will ever reproduce — silently, and discovered only when the key is needed.
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
