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
