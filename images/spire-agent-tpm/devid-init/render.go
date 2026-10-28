package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Placeholders in agent.conf. They are not ${...}, which Flux's post-build
// substitution would rewrite.
const (
	placeholderAttestor = "@NODE_ATTESTOR@"
	placeholderDataDir  = "@DATA_DIR@"
)

// render writes agent.conf with the attestor's block, <attestor>.conf from the
// same directory, in place of @NODE_ATTESTOR@, and dataDir for @DATA_DIR@.
// The agent runs one node attestor, so the config holds exactly one.
func render(configDir, attestor, dataDir, out string) error {
	tmpl, err := os.ReadFile(filepath.Join(configDir, "agent.conf"))
	if err != nil {
		return err
	}
	block, err := os.ReadFile(filepath.Join(configDir, attestor+".conf"))
	if err != nil {
		return err
	}
	conf := string(tmpl)
	for _, p := range []string{placeholderAttestor, placeholderDataDir} {
		if !strings.Contains(conf, p) {
			return fmt.Errorf("agent.conf has no %s", p)
		}
	}
	conf = strings.ReplaceAll(conf, placeholderAttestor, strings.TrimSpace(string(block)))
	conf = strings.ReplaceAll(conf, placeholderDataDir, dataDir)
	tmp := out + ".tmp"
	if err := os.WriteFile(tmp, []byte(conf), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, out)
}
