package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config is bosun's on-disk JSON configuration. A NixOS module generates it.
type Config struct {
	Repo         string       `json:"repo"`
	GitHub       GitHubConfig `json:"github"`
	RuntimeDir   string       `json:"runtimeDir"`
	LogDir       string       `json:"logDir"`
	WorkspaceDir string       `json:"workspaceDir"` // real storage, not tmpfs: it holds whole filesystem images
	MetricsFile  string       `json:"metricsFile"`  // empty disables; a node-exporter textfile, not a listener
	CacheURL     string       `json:"cacheUrl"`     // empty disables; announced to every skiff as bosun.cache on the cmdline
	BuildkitURL  string       `json:"buildkitUrl"`  // empty disables; announced to every skiff as bosun.buildkit on the cmdline
	PollInterval Duration     `json:"pollInterval"`
	// How long a stop waits for busy skiffs; idle ones are scuttled at once. A
	// deploy blocks for up to this long.
	DrainTimeout Duration         `json:"drainTimeout"`
	Classes      map[string]Class `json:"classes"`
	Bin          BinPaths         `json:"bin"`
	// nil disables the build source.
	Spindrift *SpindriftConfig `json:"spindrift,omitempty"`
}

// GitHubConfig is a GitHub App installation, which needs Administration: write
// on Config.Repo to mint JIT runner configs.
type GitHubConfig struct {
	AppID          int64  `json:"appId"`
	PrivateKeyFile string `json:"privateKeyFile"`
}

// SpindriftConfig long-polls a build outbox and runs each request on a skiff of
// one of Classes.
type SpindriftConfig struct {
	URL       string   `json:"url"`
	TokenFile string   `json:"tokenFile"`
	Classes   []string `json:"classes"`
	// The retry wait after a failed claim; the claim itself long-polls.
	PollInterval Duration `json:"pollInterval"`
}

// Class is one warm-pool class. MaxLifetime is the busy-time budget before a
// running skiff is killed.
type Class struct {
	Hull   string `json:"hull"`
	VCPUs  int    `json:"vcpus"`
	Memory string `json:"memory"` // passed through verbatim as cloud-hypervisor's --memory size=
	// Empty means no scratch disk, and then memory is the disk budget: both hull
	// families put the guest root on a tmpfs overlay.
	Workspace string `json:"workspace,omitempty"`
	// Persist hands the same workspace disks to successive skiffs of the class, so
	// a job finds the last one's caches. It needs a Workspace.
	Persist     bool     `json:"persist,omitempty"`
	Warm        int      `json:"warm"`
	MaxLifetime Duration `json:"maxLifetime"`
}

// BinPaths pins binaries to store paths; an empty field falls back to PATH.
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
	defaultWorkspaceDir = "/var/lib/bosun/workspace"
	defaultPollInterval = 30 * time.Second
	defaultDrainTimeout = 15 * time.Minute

	// The busy-time budget is the only reaper of a guest that wedged mid-job,
	// since the wedge rule skips busy skiffs.
	defaultMaxLifetime = time.Hour

	// The label the ARC runners hold; no skiff class may claim it.
	selfHosted = "self-hosted"

	// Consecutive offline polls before an idle guest counts as wedged. A runner
	// drops its connection on network blips, so one miss is not enough.
	wedgeThreshold = 3

	// How long an unconsumed JIT config stays valid; an idle skiff past it holds a
	// dead credential.
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
	if cfg.GitHub.AppID <= 0 {
		return nil, fmt.Errorf("config: github.appId is required")
	}
	if cfg.GitHub.PrivateKeyFile == "" {
		return nil, fmt.Errorf("config: github.privateKeyFile is required")
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
		if c.Workspace != "" {
			if _, err := parseSize(c.Workspace); err != nil {
				return nil, fmt.Errorf("config: class %s: workspace: %w", name, err)
			}
		} else if c.Persist {
			return nil, fmt.Errorf("config: class %s: persist needs a workspace to persist", name)
		}
		if c.Persist && strings.ContainsAny(name, "/.") {
			// Slot images are <class>-<slot>.img in one flat directory, and sweep matches
			// that shape; a '/' or '.' would escape the directory or confuse sweep.
			return nil, fmt.Errorf("config: class %s: a persisting class name may not contain '/' or '.'", name)
		}
		// warm = 0 parks a class; the next start reclaims its slot images.
		if c.Warm < 0 {
			return nil, fmt.Errorf("config: class %s: warm must not be negative", name)
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
	if cfg.WorkspaceDir == "" {
		cfg.WorkspaceDir = defaultWorkspaceDir
	}
	if cfg.PollInterval == 0 {
		cfg.PollInterval = Duration(defaultPollInterval)
	}
	if cfg.DrainTimeout <= 0 {
		cfg.DrainTimeout = Duration(defaultDrainTimeout)
	}

	if cfg.Spindrift != nil {
		sd := cfg.Spindrift
		if sd.URL == "" {
			return nil, fmt.Errorf("config: spindrift.url is required")
		}
		if sd.TokenFile == "" {
			return nil, fmt.Errorf("config: spindrift.tokenFile is required")
		}
		if len(sd.Classes) == 0 {
			return nil, fmt.Errorf("config: spindrift.classes is required")
		}
		for _, name := range sd.Classes {
			if _, ok := cfg.Classes[name]; !ok {
				return nil, fmt.Errorf("config: spindrift.classes: class %q is not declared in classes", name)
			}
		}
		if sd.PollInterval <= 0 {
			sd.PollInterval = Duration(defaultPollInterval)
		}
	}

	return &cfg, nil
}

// parseSize takes the suffixes cloud-hypervisor's --memory size= takes, so a
// class's two size fields read alike.
func parseSize(s string) (int64, error) {
	mult := int64(1)
	if s != "" {
		switch s[len(s)-1] {
		case 'K', 'k':
			mult = 1 << 10
		case 'M', 'm':
			mult = 1 << 20
		case 'G', 'g':
			mult = 1 << 30
		}
	}
	digits := s
	if mult > 1 {
		digits = s[:len(s)-1]
	}
	n, err := strconv.ParseInt(digits, 10, 64)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("invalid size %q", s)
	}
	return n * mult, nil
}
