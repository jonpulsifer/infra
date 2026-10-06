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
		"github": {"appId": 1, "privateKeyFile": "/run/secrets/key"},
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
	if time.Duration(cfg.Classes["skiff-nixos"].MaxLifetime) != defaultMaxLifetime {
		t.Errorf("maxLifetime default: got %s", cfg.Classes["skiff-nixos"].MaxLifetime)
	}
}

func TestLoadConfigRejectsSelfHostedClassName(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	writeFile(t, path, `{
		"repo": "acme/widgets",
		"github": {"appId": 1, "privateKeyFile": "/run/secrets/key"},
		"classes": {"self-hosted": {"hull": "/hulls/nixos", "vcpus": 4, "memory": "4096M", "warm": 1}}
	}`)
	if _, err := LoadConfig(path); err == nil {
		t.Fatal("expected error for class named self-hosted")
	}
}

func TestLoadConfigValidatesRepoShape(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	writeFile(t, path, `{"repo": "not-a-repo", "github": {"appId": 1, "privateKeyFile": "/x"}, "classes": {"c": {"hull":"/h","vcpus":1,"memory":"1G","warm":1}}}`)
	if _, err := LoadConfig(path); err == nil {
		t.Fatal("expected error for malformed repo")
	}
}

func TestLoadConfigRequiresAtLeastOneClass(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	writeFile(t, path, `{"repo": "acme/widgets", "github": {"appId": 1, "privateKeyFile": "/x"}, "classes": {}}`)
	if _, err := LoadConfig(path); err == nil {
		t.Fatal("expected error for no classes")
	}
}

func TestLoadConfigRequiresGithubAppID(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	writeFile(t, path, `{"repo": "acme/widgets", "github": {"privateKeyFile": "/x"}, "classes": {"c": {"hull":"/h","vcpus":1,"memory":"1G","warm":1}}}`)
	if _, err := LoadConfig(path); err == nil {
		t.Fatal("expected error for missing github.appId")
	}
}

func TestLoadConfigRequiresGithubPrivateKeyFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	writeFile(t, path, `{"repo": "acme/widgets", "github": {"appId": 1}, "classes": {"c": {"hull":"/h","vcpus":1,"memory":"1G","warm":1}}}`)
	if _, err := LoadConfig(path); err == nil {
		t.Fatal("expected error for missing github.privateKeyFile")
	}
}

func TestLoadConfigAllowsParkedClass(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	writeFile(t, path, `{"repo": "acme/widgets", "github": {"appId": 1, "privateKeyFile": "/x"}, "classes": {"c": {"hull":"/h","vcpus":1,"memory":"1G","warm":0}}}`)
	if _, err := LoadConfig(path); err != nil {
		t.Fatalf("warm = 0 is a parked class, not an error: %v", err)
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
	writeFile(t, path, `{"repo":"acme/widgets","github":{"appId":1,"privateKeyFile":"/x"},"classes":{"skiff-test":{"hull":"/h","vcpus":1,"memory":"512M","workspace":"lots","warm":1}}}`)
	if _, err := LoadConfig(path); err == nil {
		t.Fatal("expected an error for an unparseable workspace size")
	}
}

func TestLoadConfigRejectsPersistWithoutAWorkspace(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	writeFile(t, path, `{
		"repo": "acme/widgets",
		"github": {"appId": 1, "privateKeyFile": "/run/secrets/key"},
		"classes": {"skiff-ubuntu": {"hull": "/hulls/ubuntu", "vcpus": 4, "memory": "3072M", "warm": 2, "persist": true}}
	}`)
	if _, err := LoadConfig(path); err == nil {
		t.Fatal("expected error for a persisting class with no workspace")
	}
}

func TestLoadConfigRejectsAPersistingClassNameThatWouldEscapeItsImageName(t *testing.T) {
	for _, name := range []string{"skiff/ubuntu", "skiff.ubuntu"} {
		dir := t.TempDir()
		path := filepath.Join(dir, "config.json")
		writeFile(t, path, `{
			"repo": "acme/widgets",
			"github": {"appId": 1, "privateKeyFile": "/run/secrets/key"},
			"classes": {"`+name+`": {"hull": "/h", "vcpus": 1, "memory": "512M", "warm": 1, "workspace": "1G", "persist": true}}
		}`)
		if _, err := LoadConfig(path); err == nil {
			t.Errorf("expected error for persisting class named %q", name)
		}
	}
}

func TestLoadConfigDefaultsKthxEnginePollInterval(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	writeFile(t, path, `{
		"repo": "acme/widgets",
		"github": {"appId": 1, "privateKeyFile": "/run/secrets/key"},
		"classes": {"skiff-build": {"hull": "/hulls/nixos", "vcpus": 4, "memory": "4096M", "warm": 0}},
		"kthxEngine": {"url": "https://engine.example", "tokenFile": "/run/secrets/engine", "classes": ["skiff-build"]}
	}`)

	cfg, err := LoadConfig(path)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if cfg.KthxEngine == nil {
		t.Fatal("kthxEngine config should be set")
	}
	if time.Duration(cfg.KthxEngine.PollInterval) != defaultPollInterval {
		t.Errorf("kthxEngine pollInterval default: got %s", cfg.KthxEngine.PollInterval)
	}
}

func TestLoadConfigReadsTheLegacySpindriftKey(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	writeFile(t, path, `{
		"repo": "acme/widgets",
		"github": {"appId": 1, "privateKeyFile": "/run/secrets/key"},
		"classes": {"skiff-build": {"hull": "/hulls/nixos", "vcpus": 4, "memory": "4096M", "warm": 0}},
		"spindrift": {"url": "https://engine.example", "tokenFile": "/run/secrets/engine", "classes": ["skiff-build"]}
	}`)

	cfg, err := LoadConfig(path)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if cfg.KthxEngine == nil || cfg.KthxEngine.URL != "https://engine.example" {
		t.Fatalf("the legacy key should populate KthxEngine, got %+v", cfg.KthxEngine)
	}
}

func TestLoadConfigRejectsBothEngineKeys(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	engine := `{"url": "https://engine.example", "tokenFile": "/x", "classes": ["skiff-build"]}`
	writeFile(t, path, `{
		"repo": "acme/widgets",
		"github": {"appId": 1, "privateKeyFile": "/run/secrets/key"},
		"classes": {"skiff-build": {"hull": "/h", "vcpus": 1, "memory": "1G", "warm": 0}},
		"kthxEngine": `+engine+`,
		"spindrift": `+engine+`
	}`)
	if _, err := LoadConfig(path); err == nil {
		t.Fatal("expected error when both kthxEngine and spindrift are set")
	}
}

func TestLoadConfigOmittedKthxEngineIsNil(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	writeFile(t, path, `{
		"repo": "acme/widgets",
		"github": {"appId": 1, "privateKeyFile": "/run/secrets/key"},
		"classes": {"skiff-nixos": {"hull": "/hulls/nixos", "vcpus": 4, "memory": "4096M", "warm": 1}}
	}`)

	cfg, err := LoadConfig(path)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if cfg.KthxEngine != nil {
		t.Fatalf("kthxEngine should be nil when omitted, got %+v", cfg.KthxEngine)
	}
}

func TestLoadConfigRejectsKthxEngineMissingURL(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	writeFile(t, path, `{
		"repo": "acme/widgets",
		"github": {"appId": 1, "privateKeyFile": "/run/secrets/key"},
		"classes": {"skiff-build": {"hull": "/h", "vcpus": 1, "memory": "1G", "warm": 0}},
		"kthxEngine": {"tokenFile": "/x", "classes": ["skiff-build"]}
	}`)
	if _, err := LoadConfig(path); err == nil {
		t.Fatal("expected error for kthxEngine with no url")
	}
}

func TestLoadConfigRejectsKthxEngineMissingTokenFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	writeFile(t, path, `{
		"repo": "acme/widgets",
		"github": {"appId": 1, "privateKeyFile": "/run/secrets/key"},
		"classes": {"skiff-build": {"hull": "/h", "vcpus": 1, "memory": "1G", "warm": 0}},
		"kthxEngine": {"url": "https://engine.example", "classes": ["skiff-build"]}
	}`)
	if _, err := LoadConfig(path); err == nil {
		t.Fatal("expected error for kthxEngine with no tokenFile")
	}
}

func TestLoadConfigRejectsKthxEngineWithNoClasses(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	writeFile(t, path, `{
		"repo": "acme/widgets",
		"github": {"appId": 1, "privateKeyFile": "/run/secrets/key"},
		"classes": {"skiff-build": {"hull": "/h", "vcpus": 1, "memory": "1G", "warm": 0}},
		"kthxEngine": {"url": "https://engine.example", "tokenFile": "/x", "classes": []}
	}`)
	if _, err := LoadConfig(path); err == nil {
		t.Fatal("expected error for kthxEngine with no classes")
	}
}

func TestLoadConfigRejectsKthxEngineClassNotDeclaredInClasses(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	writeFile(t, path, `{
		"repo": "acme/widgets",
		"github": {"appId": 1, "privateKeyFile": "/run/secrets/key"},
		"classes": {"skiff-nixos": {"hull": "/h", "vcpus": 1, "memory": "1G", "warm": 1}},
		"kthxEngine": {"url": "https://engine.example", "tokenFile": "/x", "classes": ["skiff-build"]}
	}`)
	if _, err := LoadConfig(path); err == nil {
		t.Fatal("expected error for a kthxEngine class not declared in classes")
	}
}

func TestLoadConfigAllowsADottedClassNameThatDoesNotPersist(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	writeFile(t, path, `{
		"repo": "acme/widgets",
		"github": {"appId": 1, "privateKeyFile": "/run/secrets/key"},
		"classes": {"skiff.ubuntu": {"hull": "/h", "vcpus": 1, "memory": "512M", "warm": 1}}
	}`)
	if _, err := LoadConfig(path); err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
}
