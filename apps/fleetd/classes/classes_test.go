package classes

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func load(t *testing.T, body string) error {
	t.Helper()
	path := filepath.Join(t.TempDir(), "classes.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := Load(path)
	return err
}

func TestLoadRequiresAWellFormedWorkload(t *testing.T) {
	const entry = `{"c": {"os": "nixos", %s"template": "t", "policy_profile": "p", "payload_kind": "nixos-image"}}`
	if err := load(t, strings.Replace(entry, "%s", `"workload": "general", `, 1)); err != nil {
		t.Fatalf("a valid class: %v", err)
	}
	for name, field := range map[string]string{
		"missing":   "",
		"empty":     `"workload": "", `,
		"uppercase": `"workload": "General", `,
		"digit":     `"workload": "1x", `,
		"space":     `"workload": "a b", `,
	} {
		if err := load(t, strings.Replace(entry, "%s", field, 1)); err == nil || !strings.Contains(err.Error(), "workload") {
			t.Errorf("%s workload: %v", name, err)
		}
	}
}
