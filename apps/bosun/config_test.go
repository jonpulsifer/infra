package main

import (
	"encoding/json"
	"path/filepath"
	"testing"
	"time"
)

func TestLoadConfigDefaults(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	writeFile(t, path, `{
		"repo": "acme/widgets",
		"tokenFile": "/run/secrets/token",
		"classes": {"skiff-nixos": {"hull": "/hulls/nixos", "vcpus": 4, "memory": "4096M", "warm": 1}}
	}`)

	cfg, err := LoadConfig(path)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if cfg.RuntimeDir != defaultRuntimeDir {
		t.Errorf("runtimeDir default: got %s", cfg.RuntimeDir)
	}
	if cfg.LogDir != defaultLogDir {
		t.Errorf("logDir default: got %s", cfg.LogDir)
	}
	if time.Duration(cfg.PollInterval) != defaultPollInterval {
		t.Errorf("pollInterval default: got %s", cfg.PollInterval)
	}
	// Not optional: the busy-time budget is the only thing that reaps a skiff
	// whose guest wedged mid-job, so a class that declares none still gets one.
	if time.Duration(cfg.Classes["skiff-nixos"].MaxLifetime) != defaultMaxLifetime {
		t.Errorf("maxLifetime default: got %s", cfg.Classes["skiff-nixos"].MaxLifetime)
	}
}

func TestLoadConfigRejectsSelfHostedClassName(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	writeFile(t, path, `{
		"repo": "acme/widgets",
		"tokenFile": "/run/secrets/token",
		"classes": {"self-hosted": {"hull": "/hulls/nixos", "vcpus": 4, "memory": "4096M", "warm": 1}}
	}`)
	if _, err := LoadConfig(path); err == nil {
		t.Fatal("expected error for class named self-hosted")
	}
}

func TestLoadConfigValidatesRepoShape(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	writeFile(t, path, `{"repo": "not-a-repo", "tokenFile": "/x", "classes": {"c": {"hull":"/h","vcpus":1,"memory":"1G","warm":1}}}`)
	if _, err := LoadConfig(path); err == nil {
		t.Fatal("expected error for malformed repo")
	}
}

func TestLoadConfigRequiresAtLeastOneClass(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	writeFile(t, path, `{"repo": "acme/widgets", "tokenFile": "/x", "classes": {}}`)
	if _, err := LoadConfig(path); err == nil {
		t.Fatal("expected error for no classes")
	}
}

func TestDurationUnmarshal(t *testing.T) {
	var d Duration
	if err := json.Unmarshal([]byte(`"30s"`), &d); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if time.Duration(d) != 30*time.Second {
		t.Errorf("got %s", d)
	}

	if err := json.Unmarshal([]byte(`"not-a-duration"`), &d); err == nil {
		t.Fatal("expected error for invalid duration string")
	}
}

func TestParseSize(t *testing.T) {
	for in, want := range map[string]int64{
		"6G":   6 << 30,
		"512M": 512 << 20,
		"64k":  64 << 10,
		"4096": 4096,
	} {
		got, err := parseSize(in)
		if err != nil {
			t.Errorf("parseSize(%q): %v", in, err)
			continue
		}
		if got != want {
			t.Errorf("parseSize(%q) = %d, want %d", in, got, want)
		}
	}
	for _, in := range []string{"", "0", "-1G", "6GB", "big", "G"} {
		if _, err := parseSize(in); err == nil {
			t.Errorf("parseSize(%q): expected an error", in)
		}
	}
}

func TestLoadConfigRejectsUnparseableWorkspaceSize(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	writeFile(t, path, `{"repo":"acme/widgets","tokenFile":"/x","classes":{"skiff-test":{"hull":"/h","vcpus":1,"memory":"512M","workspace":"lots","warm":1}}}`)
	if _, err := LoadConfig(path); err == nil {
		t.Fatal("expected an error for an unparseable workspace size")
	}
}

// persist is what a class trades the "leaves nothing behind" stance for, and
// what it buys is a warm cache on a disk. A class that persists nothing is a
// declaration whose only possible effect is to mislead whoever reads it.
func TestLoadConfigRejectsPersistWithoutAWorkspace(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	writeFile(t, path, `{
		"repo": "acme/widgets",
		"tokenFile": "/run/secrets/token",
		"classes": {"skiff-ubuntu": {"hull": "/hulls/ubuntu", "vcpus": 4, "memory": "3072M", "warm": 2, "persist": true}}
	}`)
	if _, err := LoadConfig(path); err == nil {
		t.Fatal("expected error for a persisting class with no workspace")
	}
}

// Slot images live in one flat directory named <class>-<slot>.img, and sweep
// tells a slot image from an orphan by that shape alone.
func TestLoadConfigRejectsAPersistingClassNameThatWouldEscapeItsImageName(t *testing.T) {
	for _, name := range []string{"skiff/ubuntu", "skiff.ubuntu"} {
		dir := t.TempDir()
		path := filepath.Join(dir, "config.json")
		writeFile(t, path, `{
			"repo": "acme/widgets",
			"tokenFile": "/run/secrets/token",
			"classes": {"`+name+`": {"hull": "/h", "vcpus": 1, "memory": "512M", "warm": 1, "workspace": "1G", "persist": true}}
		}`)
		if _, err := LoadConfig(path); err == nil {
			t.Errorf("expected error for persisting class named %q", name)
		}
	}
}

// The same names are fine when nothing persists: only the slot image naming
// constrains them.
func TestLoadConfigAllowsADottedClassNameThatDoesNotPersist(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	writeFile(t, path, `{
		"repo": "acme/widgets",
		"tokenFile": "/run/secrets/token",
		"classes": {"skiff.ubuntu": {"hull": "/h", "vcpus": 1, "memory": "512M", "warm": 1}}
	}`)
	if _, err := LoadConfig(path); err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
}
