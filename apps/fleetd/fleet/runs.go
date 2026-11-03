package fleet

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Run is fleetd's record of the BMC work for one run in native mode, by
// the run's Workflow name. In rufio mode the Workflow's annotations and
// Rufio's Jobs hold the same facts.
type Run struct {
	Node   string `json:"node"`
	Action string `json:"action"`
	// Attempt counts a retirement's attempts since one ended at its netboot,
	// as AttemptAnnotation does; 0 is 1.
	Attempt int `json:"attempt,omitempty"`
	// Supersedes names the run this retirement superseded.
	Supersedes string `json:"supersedes,omitempty"`
	// BootedAt is when fleetd started to netboot the machine for the run.
	// BootOffRequested says the BMC took the netboot's power-off, and Booted
	// that it took the power-on; a netboot between the two is pending, and a
	// later pass resumes it. BootFailed is the BMC's answer when the netboot
	// failed, and then the run has no Workflow. Recorded says NetBox names
	// the failed run.
	BootedAt         time.Time `json:"booted_at,omitzero"`
	BootOffRequested bool      `json:"boot_off_requested,omitempty"`
	Booted           bool      `json:"booted,omitempty"`
	BootFailed       string    `json:"boot_failed,omitempty"`
	Recorded         bool      `json:"recorded,omitempty"`
	// PowerWaitStartedAt is PowerWaitAnnotation's time.
	PowerWaitStartedAt time.Time `json:"power_wait_started_at,omitzero"`
	// StopAt is when the BMC took fleetd's power-off that stops the run, and
	// Stop its outcome, jobCompleted or jobFailed, empty while the machine
	// is not off yet; StopReason is a failure's reason.
	StopAt     time.Time `json:"stop_at,omitzero"`
	Stop       string    `json:"stop,omitempty"`
	StopReason string    `json:"stop_reason,omitempty"`
}

// pending says whether the run's netboot has started and neither booted
// the machine nor failed.
func (r Run) pending() bool { return !r.BootedAt.IsZero() && !r.Booted && r.BootFailed == "" }

// attempt is the run's Attempt, at least 1.
func (r Run) attempt() int { return max(r.Attempt, 1) }

// Runs keeps each Run in one JSON file, written beside itself and renamed,
// so a restart reads the whole record or the one before.
type Runs struct {
	File string

	mu     sync.Mutex
	runs   map[string]Run
	loaded bool
}

func (s *Runs) load() error {
	if s.loaded {
		return nil
	}
	s.runs = map[string]Run{}
	b, err := os.ReadFile(s.File)
	if errors.Is(err, os.ErrNotExist) {
		s.loaded = true
		return nil
	}
	if err != nil {
		return err
	}
	if err := json.Unmarshal(b, &s.runs); err != nil {
		return fmt.Errorf("%s: %w", s.File, err)
	}
	s.loaded = true
	return nil
}

func (s *Runs) save() error {
	b, err := json.MarshalIndent(s.runs, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(filepath.Dir(s.File), "."+filepath.Base(s.File)+".tmp")
	if err := os.WriteFile(tmp, append(b, '\n'), 0o640); err != nil {
		return err
	}
	if err := os.Rename(tmp, s.File); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// Get reads the run's record.
func (s *Runs) Get(name string) (Run, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.load(); err != nil {
		return Run{}, false, err
	}
	r, ok := s.runs[name]
	return r, ok, nil
}

// Put writes the run's record.
func (s *Runs) Put(name string, r Run) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.load(); err != nil {
		return err
	}
	s.runs[name] = r
	return s.save()
}

// Latest is the node's newest netboot, the run of its last request in
// native mode, as the newest Workflow is in rufio mode.
func (s *Runs) Latest(node string) (string, Run, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.load(); err != nil {
		return "", Run{}, false, err
	}
	var newest string
	for name, r := range s.runs {
		if r.Node == node && !r.BootedAt.IsZero() && (newest == "" || r.BootedAt.After(s.runs[newest].BootedAt)) {
			newest = name
		}
	}
	r, ok := s.runs[newest]
	return newest, r, ok, nil
}

// Prune drops every record keep refuses.
func (s *Runs) Prune(keep func(name string, run Run) bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.load(); err != nil {
		return err
	}
	changed := false
	for name := range s.runs {
		if !keep(name, s.runs[name]) {
			delete(s.runs, name)
			changed = true
		}
	}
	if !changed {
		return nil
	}
	return s.save()
}
