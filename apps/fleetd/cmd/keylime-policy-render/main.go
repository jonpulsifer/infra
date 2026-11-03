// keylime-policy-render writes each profile in apps/fleetd/attest/policy/ as
// the measured-boot reference state Keylime's fleetd-profile policy reads,
// one <profile>.json per profile, for the running node: required_authorities
// is the profile's renew_required_authorities. `mise run keylime:render-policies`
// writes them to clusters/folly/apps/keylime/policies/, and -check exits 1
// when a committed file differs from a fresh render, so a profile change
// that misses the render fails CI.
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"github.com/jonpulsifer/infra/apps/fleetd/attest"
)

func main() {
	profiles := flag.String("profiles", "attest/policy", "directory of fleetd policy profiles, one <name>.yaml each")
	out := flag.String("out", "", "directory to write <name>.json into (required)")
	check := flag.Bool("check", false, "compare instead of writing; exit 1 on a difference")
	flag.Parse()
	if *out == "" {
		flag.Usage()
		os.Exit(2)
	}
	if err := run(*profiles, *out, *check); err != nil {
		fmt.Fprintln(os.Stderr, "keylime-policy-render:", err)
		os.Exit(1)
	}
}

func run(profiles, out string, check bool) error {
	loaded, err := attest.LoadPolicies(profiles)
	if err != nil {
		return err
	}
	names := make([]string, 0, len(loaded))
	for n := range loaded {
		names = append(names, n)
	}
	sort.Strings(names)
	var stale []string
	for _, n := range names {
		rendered, err := Render(loaded[n])
		if err != nil {
			return fmt.Errorf("%s: %w", n, err)
		}
		path := filepath.Join(out, n+".json")
		if check {
			have, err := os.ReadFile(path)
			if err != nil || !bytes.Equal(have, rendered) {
				stale = append(stale, path)
			}
			continue
		}
		if err := os.MkdirAll(out, 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(path, rendered, 0o644); err != nil {
			return err
		}
	}
	if len(stale) > 0 {
		return fmt.Errorf("stale, run `mise run keylime:render-policies`: %v", stale)
	}
	return nil
}

// Render is the file for one profile: indented JSON with sorted keys and a
// trailing newline, so a re-render of an unchanged profile is a no-op.
func Render(p *attest.Policy) ([]byte, error) {
	b, err := json.MarshalIndent(attest.KeylimeRefstate(p, true), "", "  ")
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}
