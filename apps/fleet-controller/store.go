package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// An install code is 32 random bytes as base64url without padding, and a
// machine's UUID is its SMBIOS UUID in lower case, as Talos fills ${uuid}.
var (
	codePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
)

// Pending is what the store keeps beside a rendered config: who it is for,
// when it was rendered, and when nginx served it. A served config's file is
// gone; its record stays until NetBox has the release.
type Pending struct {
	UUID     string    `json:"uuid"`
	Code     string    `json:"code"`
	Serial   string    `json:"serial"`
	Node     string    `json:"node"`
	Class    string    `json:"class"`
	Workflow string    `json:"workflow"`
	Rendered time.Time `json:"rendered"`
	Fetched  time.Time `json:"fetched,omitzero"`
}

// Store holds the rendered configs that nginx serves at /talos/config, as
// <dir>/<uuid>/<code>.yaml. A config is mode 0640 in directories of 0750, all
// in the service's group, which nginx is a member of. Its record,
// <code>.json, is mode 0600, so nginx serves the config and nothing else.
type Store struct {
	Dir string

	mu sync.Mutex
}

func (s *Store) paths(uuid, code string) (cfg, record string) {
	base := filepath.Join(s.Dir, uuid, code)
	return base + ".yaml", base + ".json"
}

// writeFile writes a file whole under a temporary name and renames it into
// place, so nginx never serves half a config. The mode is set explicitly:
// the service's umask would take the group's read bit.
func writeFile(path string, data []byte, mode os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

func mkdir(path string) error {
	if err := os.MkdirAll(path, 0o750); err != nil {
		return err
	}
	return os.Chmod(path, 0o750)
}

// Put writes a config and its record. A machine has one config at a time:
// the configs of its older codes are deleted, since only the newest code is
// in its META.
func (s *Store) Put(p Pending, cfg []byte) error {
	if !uuidPattern.MatchString(p.UUID) || !codePattern.MatchString(p.Code) {
		return fmt.Errorf("uuid %q or the code is malformed", p.UUID)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := mkdir(s.Dir); err != nil {
		return err
	}
	if err := mkdir(filepath.Join(s.Dir, p.UUID)); err != nil {
		return err
	}
	others, err := s.records(p.UUID)
	if err != nil {
		return err
	}
	for _, o := range others {
		if o.Code == p.Code {
			continue
		}
		cfgPath, recPath := s.paths(o.UUID, o.Code)
		if err := os.Remove(cfgPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if o.Fetched.IsZero() {
			if err := os.Remove(recPath); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
		}
	}
	rec, err := json.Marshal(p)
	if err != nil {
		return err
	}
	cfgPath, recPath := s.paths(p.UUID, p.Code)
	if err := writeFile(recPath, rec, 0o600); err != nil {
		return err
	}
	return writeFile(cfgPath, cfg, 0o640)
}

// records reads a machine's records, or every machine's for uuid "".
func (s *Store) records(uuid string) ([]Pending, error) {
	pattern := filepath.Join(s.Dir, "*", "*.json")
	if uuid != "" {
		pattern = filepath.Join(s.Dir, uuid, "*.json")
	}
	matches, err := filepath.Glob(pattern)
	if err != nil {
		return nil, err
	}
	var out []Pending
	for _, m := range matches {
		b, err := os.ReadFile(m)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return nil, err
		}
		var p Pending
		if err := json.Unmarshal(b, &p); err != nil {
			return nil, fmt.Errorf("%s: %w", m, err)
		}
		out = append(out, p)
	}
	sort.Slice(out, func(a, b int) bool { return out[a].Rendered.Before(out[b].Rendered) })
	return out, nil
}

// Records lists every record, oldest first.
func (s *Store) Records() ([]Pending, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.records("")
}

// Served burns a config nginx just served: the file goes, and the record
// keeps the time until the release is in NetBox. ok is false for a code the
// store does not hold, or one already served.
func (s *Store) Served(uuid, code string, at time.Time) (Pending, bool, error) {
	if !uuidPattern.MatchString(uuid) || !codePattern.MatchString(code) {
		return Pending{}, false, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	cfgPath, recPath := s.paths(uuid, code)
	b, err := os.ReadFile(recPath)
	if errors.Is(err, os.ErrNotExist) {
		return Pending{}, false, nil
	}
	if err != nil {
		return Pending{}, false, err
	}
	var p Pending
	if err := json.Unmarshal(b, &p); err != nil {
		return Pending{}, false, err
	}
	if err := os.Remove(cfgPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return Pending{}, false, err
	}
	if !p.Fetched.IsZero() {
		return p, false, nil
	}
	p.Fetched = at
	rec, err := json.Marshal(p)
	if err != nil {
		return Pending{}, false, err
	}
	return p, true, writeFile(recPath, rec, 0o600)
}

// Drop deletes a config and its record, and the machine's directory once it
// is empty.
func (s *Store) Drop(p Pending) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cfgPath, recPath := s.paths(p.UUID, p.Code)
	for _, f := range []string{cfgPath, recPath} {
		if err := os.Remove(f); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	_ = os.Remove(filepath.Dir(cfgPath))
	return nil
}

// Strays deletes what no record explains: a config file whose record is
// gone, or a temporary file a crash left, once it is older than ttl.
func (s *Store) Strays(now time.Time, ttl time.Duration) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	matches, err := filepath.Glob(filepath.Join(s.Dir, "*", "*"))
	if err != nil {
		return err
	}
	var errs []error
	for _, m := range matches {
		name := filepath.Base(m)
		rec := strings.TrimSuffix(m, ".yaml") + ".json"
		orphan := strings.HasPrefix(name, ".tmp-")
		if strings.HasSuffix(name, ".yaml") {
			if _, err := os.Stat(rec); errors.Is(err, os.ErrNotExist) {
				orphan = true
			}
		}
		if !orphan {
			continue
		}
		if fi, err := os.Stat(m); err == nil && now.Sub(fi.ModTime()) > ttl {
			if err := os.Remove(m); err != nil && !errors.Is(err, os.ErrNotExist) {
				errs = append(errs, err)
			}
		}
	}
	dirs, _ := filepath.Glob(filepath.Join(s.Dir, "*"))
	for _, d := range dirs {
		// Only an empty directory goes.
		_ = os.Remove(d)
	}
	return errors.Join(errs...)
}
