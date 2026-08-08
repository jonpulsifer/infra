package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"
)

// Config is bosun's on-disk JSON configuration. A NixOS module generates it.
type Config struct {
	Repo         string           `json:"repo"`
	TokenFile    string           `json:"tokenFile"`
	RuntimeDir   string           `json:"runtimeDir"`
	LogDir       string           `json:"logDir"`
	MetricsFile  string           `json:"metricsFile"` // empty disables; a node-exporter textfile, not a listener
	PollInterval Duration         `json:"pollInterval"`
	Classes      map[string]Class `json:"classes"`
	Bin          BinPaths         `json:"bin"`
}

// Class is one warm-pool class: a hull to boot, its resources, how many
// skiffs to keep warm, and the busy-time budget before a running skiff is
// scuttled and replaced.
type Class struct {
	Hull        string   `json:"hull"`
	VCPUs       int      `json:"vcpus"`
	Memory      string   `json:"memory"` // passed through verbatim as cloud-hypervisor's --memory size=
	Warm        int      `json:"warm"`
	MaxLifetime Duration `json:"maxLifetime"`
}

// BinPaths overrides binary lookups so a NixOS module can pin store paths.
// Empty fields fall back to a PATH lookup by bare name.
type BinPaths struct {
	CloudHypervisor string `json:"cloudHypervisor"`
	Virtiofsd       string `json:"virtiofsd"`
	Passt           string `json:"passt"`
}

// Duration unmarshals JSON string durations like "30s" or "1h".
type Duration time.Duration

func (d Duration) String() string { return time.Duration(d).String() }

func (d *Duration) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return err
	}
	parsed, err := time.ParseDuration(s)
	if err != nil {
		return fmt.Errorf("invalid duration %q: %w", s, err)
	}
	*d = Duration(parsed)
	return nil
}

const (
	defaultRuntimeDir   = "/run/bosun"
	defaultLogDir       = "/var/log/bosun"
	defaultPollInterval = 30 * time.Second

	// defaultMaxLifetime backstops a class that declares no budget. It is a
	// default rather than "unlimited" because the busy-time budget is the
	// only thing that reaps a skiff whose guest wedged mid-job -- the wedge
	// detector deliberately will not touch one.
	defaultMaxLifetime = time.Hour

	// selfHosted is the label the existing ARC runners hold. A skiff class
	// must never claim it.
	selfHosted = "self-hosted"

	// wedgeThreshold is how many consecutive offline observations it takes to
	// call an idle guest wedged. A runner drops its connection whenever the
	// network hiccups -- observed live, one minute after a transient
	// "connection reset by peer" on the poll itself. Debouncing it is why the
	// rule is safe to apply at all; not applying it to a busy skiff is why a
	// job is never the thing it kills.
	wedgeThreshold = 3

	// jitExpiry is how long a generated JIT config is valid if never
	// consumed. Idle recycling is derived from it: a skiff that never goes
	// online within this window is holding a dead credential.
	jitExpiry = time.Hour
)

func LoadConfig(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading config: %w", err)
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parsing config: %w", err)
	}

	if owner, name, ok := strings.Cut(cfg.Repo, "/"); !ok || owner == "" || name == "" {
		return nil, fmt.Errorf("config: repo must be \"owner/repo\", got %q", cfg.Repo)
	}
	if cfg.TokenFile == "" {
		return nil, fmt.Errorf("config: tokenFile is required")
	}
	if len(cfg.Classes) == 0 {
		return nil, fmt.Errorf("config: at least one class is required")
	}
	for name, c := range cfg.Classes {
		if name == selfHosted {
			return nil, fmt.Errorf("config: class name %q is reserved for the existing ARC runners", name)
		}
		if c.Hull == "" {
			return nil, fmt.Errorf("config: class %s: hull is required", name)
		}
		if c.VCPUs <= 0 {
			return nil, fmt.Errorf("config: class %s: vcpus must be positive", name)
		}
		if c.Memory == "" {
			return nil, fmt.Errorf("config: class %s: memory is required", name)
		}
		if c.Warm <= 0 {
			return nil, fmt.Errorf("config: class %s: warm must be positive", name)
		}
		if c.MaxLifetime <= 0 {
			c.MaxLifetime = Duration(defaultMaxLifetime)
			cfg.Classes[name] = c
		}
	}

	if cfg.RuntimeDir == "" {
		cfg.RuntimeDir = defaultRuntimeDir
	}
	if cfg.LogDir == "" {
		cfg.LogDir = defaultLogDir
	}
	if cfg.PollInterval == 0 {
		cfg.PollInterval = Duration(defaultPollInterval)
	}
	return &cfg, nil
}
