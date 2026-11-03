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
	// BootedAt is when fleetd netbooted the machine for the run.
	// BootFailed is the BMC's answer when that failed, and then the run has
	// no Workflow. Recorded says NetBox names the failed run.
	BootedAt   time.Time `json:"booted_at,omitzero"`
	BootFailed string    `json:"boot_failed,omitempty"`
	Recorded   bool      `json:"recorded,omitempty"`
	// PowerWaitStartedAt is PowerWaitAnnotation's time.
	PowerWaitStartedAt time.Time `json:"power_wait_started_at,omitzero"`
	// StopAt is when fleetd asked the BMC to power the machine off to stop
	// the run, and Stop its outcome, jobCompleted or jobFailed, empty while
	// the machine is not off yet; StopReason is a failure's reason.
	StopAt     time.Time `json:"stop_at,omitzero"`
	Stop       string    `json:"stop,omitempty"`
	StopReason string    `json:"stop_reason,omitempty"`
}

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

// Unrecorded is the node's newest netboot when it was a run of the action
// that failed and that NetBox does not name yet. A netboot since, of any
// action, means the request moved on, as the newest Workflow does in rufio
// mode.
func (s *Runs) Unrecorded(node, action string) (string, Run, bool, error) {
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
	if !ok || r.Action != action || r.BootFailed == "" || r.Recorded {
		return "", Run{}, false, nil
	}
	return newest, r, true, nil
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
