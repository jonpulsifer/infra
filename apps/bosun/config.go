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
	Repo         string   `json:"repo"`
	TokenFile    string   `json:"tokenFile"`
	RuntimeDir   string   `json:"runtimeDir"`
	LogDir       string   `json:"logDir"`
	WorkspaceDir string   `json:"workspaceDir"` // real storage, not tmpfs: it holds whole filesystem images
	MetricsFile  string   `json:"metricsFile"`  // empty disables; a node-exporter textfile, not a listener
	CacheURL     string   `json:"cacheUrl"`     // empty disables; announced to every skiff as bosun.cache on the cmdline
	PollInterval Duration `json:"pollInterval"`
	// DrainTimeout bounds how long a stop waits for busy skiffs to finish
	// their jobs. Idle skiffs are scuttled immediately; what this buys is a
	// deploy that no longer fails every in-flight job, and what it costs is
	// a stop (and so a deploy) that blocks for up to this long.
	DrainTimeout Duration         `json:"drainTimeout"`
	Classes      map[string]Class `json:"classes"`
	Bin          BinPaths         `json:"bin"`
	// Spindrift turns this host into a build source alongside its GitHub warm
	// pool. nil (the default) means bosun never talks to Spindrift.
	Spindrift *SpindriftConfig `json:"spindrift,omitempty"`
}

// SpindriftConfig is how a bosun host long-polls a Spindrift outbox for
// build requests and runs each on a skiff of one of Classes, instead of only
// ever registering GitHub runners.
type SpindriftConfig struct {
	URL       string   `json:"url"`
	TokenFile string   `json:"tokenFile"`
	Classes   []string `json:"classes"`
	// PollInterval is the retry wait after a failed claim, not the poll
	// cadence itself -- the claim call long-polls server-side, so a
	// successful round trip is the wait.
	PollInterval Duration `json:"pollInterval"`
}

// Class is one warm-pool class: a hull to boot, its resources, how many
// skiffs to keep warm, and the busy-time budget before a running skiff is
// scuttled and replaced.
type Class struct {
	Hull   string `json:"hull"`
	VCPUs  int    `json:"vcpus"`
	Memory string `json:"memory"` // passed through verbatim as cloud-hypervisor's --memory size=
	// Workspace sizes a scratch disk for this class; empty means none, and
	// then the class's memory is its disk budget, since both hull families
	// put the guest root on a tmpfs overlay.
	Workspace string `json:"workspace,omitempty"`
	// Persist hands the same workspace disks back to successive skiffs of this
	// class instead of a freshly reserved one each boot. The disk is the only
	// thing a skiff has that *could* outlive it, so this is the one place the
	// "a skiff leaves nothing behind" stance is traded away, deliberately and
	// per class: what survives is a warm cache, and what it buys is the entire
	// measured gap to a hosted runner, which is network transfer and nothing
	// else.
	//
	// Off by default. A class that sets it must also size a workspace, since
	// there is otherwise no disk to persist.
	Persist     bool     `json:"persist,omitempty"`
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
	defaultWorkspaceDir = "/var/lib/bosun/workspace"
	defaultPollInterval = 30 * time.Second
	defaultDrainTimeout = 15 * time.Minute

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
		if c.Workspace != "" {
			if _, err := parseSize(c.Workspace); err != nil {
				return nil, fmt.Errorf("config: class %s: workspace: %w", name, err)
			}
		} else if c.Persist {
			return nil, fmt.Errorf("config: class %s: persist needs a workspace to persist", name)
		}
		if c.Persist && strings.ContainsAny(name, "/.") {
			// Slot images are named <class>-<slot>.img under one flat
			// directory, and sweep tells a slot image from an orphan by that
			// shape. A class name carrying a separator or a dot would either
			// escape the directory or produce a name sweep reads as somebody
			// else's.
			return nil, fmt.Errorf("config: class %s: a persisting class name may not contain '/' or '.'", name)
		}
		// warm = 0 is a parked class: declared, serving nothing. The pool
		// reclaims its slot images on start, so parking also frees the disk.
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

// parseSize turns "6G", "512M" or a bare byte count into bytes, taking the
// same suffixes cloud-hypervisor's --memory size= does so a class's two size
// fields read alike.
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
