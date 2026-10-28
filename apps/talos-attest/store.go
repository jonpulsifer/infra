package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"sync"
	"time"
)

// Record is one machine's attestation state, machines/<name>/record.json.
type Record struct {
	Machine   string            `json:"machine"`
	Serial    string            `json:"serial"`
	UUID      string            `json:"uuid,omitempty"`
	MAC       string            `json:"mac,omitempty"`
	Status    string            `json:"status"`
	Reason    string            `json:"reason,omitempty"`
	Detail    []string          `json:"detail,omitempty"`
	EKHashes  map[string]string `json:"ek_hashes,omitempty"`
	EKIssuers []string          `json:"ek_issuers,omitempty"`
	// RSAEKCert is whether the TPM holds an RSA EK certificate, the only
	// one SPIRE's tpm_devid agent reads.
	RSAEKCert      bool      `json:"rsa_ek_cert"`
	LDevIDSerial   string    `json:"ldevid_serial,omitempty"`
	LDevIDNotAfter time.Time `json:"ldevid_not_after,omitzero"`
	LAKSerial      string    `json:"lak_serial,omitempty"`
	AttestedAt     time.Time `json:"attested_at,omitzero"`
	Confirmed      bool      `json:"confirmed,omitempty"`
	NVIndexes      []uint32  `json:"nv_indexes,omitempty"`
	// BootApplications are the Authenticode digests PCR 4 recorded after
	// its separator, for pinning in the policy.
	BootApplications []string  `json:"boot_applications,omitempty"`
	UpdatedAt        time.Time `json:"updated_at"`
}

// Statuses a record can hold.
const (
	StatusAttested    = "attested"
	StatusQuarantined = "quarantined"
	StatusPending     = "pending-approval"
)

// Issued reports whether the record's LDevID may be served.
func (r Record) Issued() bool { return r.Status == StatusAttested }

// Store keeps each machine's record and files under dir, the approvals of
// first-intake EK hashes, and an append-only verdict journal. Writes go
// through a temporary file and a rename.
type Store struct {
	dir string
	mu  sync.Mutex
}

// Files a machine directory holds after a pass.
const (
	fileLDevIDCert = "ldevid.crt"
	fileLAKCert    = "lak.crt"
	fileChain      = "chain.pem"
	fileLDevIDPub  = "ldevid.pub"
	fileLDevIDPriv = "ldevid.priv"
	fileAKPub      = "ak.pub"
	fileAKPriv     = "ak.priv"
)

// ServedFiles are the files GET /devid/<serial>/<file> returns raw.
var ServedFiles = []string{fileLDevIDCert, fileLAKCert, fileChain, fileLDevIDPub, fileLDevIDPriv, fileAKPub, fileAKPriv}

func OpenStore(dir string) (*Store, error) {
	if err := os.MkdirAll(filepath.Join(dir, "machines"), 0o750); err != nil {
		return nil, err
	}
	return &Store{dir: dir}, nil
}

func (s *Store) machineDir(name string) string { return filepath.Join(s.dir, "machines", name) }

func writeAtomic(path string, b []byte, mode fs.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// Record returns a machine's record, and false when it has none.
func (s *Store) Record(name string) (Record, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.record(name)
}

func (s *Store) record(name string) (Record, bool, error) {
	b, err := os.ReadFile(filepath.Join(s.machineDir(name), "record.json"))
	if errors.Is(err, fs.ErrNotExist) {
		return Record{}, false, nil
	}
	if err != nil {
		return Record{}, false, err
	}
	var r Record
	if err := json.Unmarshal(b, &r); err != nil {
		return Record{}, false, fmt.Errorf("record of %s: %w", name, err)
	}
	return r, true, nil
}

// Save writes a record and its files together; files are written first, so
// a record never names files that are missing.
func (s *Store) Save(r Record, files map[string][]byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	dir := s.machineDir(r.Machine)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return err
	}
	names := make([]string, 0, len(files))
	for n := range files {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		if !slices.Contains(ServedFiles, n) {
			return fmt.Errorf("unexpected file %s", n)
		}
		if err := writeAtomic(filepath.Join(dir, n), files[n], 0o640); err != nil {
			return err
		}
	}
	b, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(filepath.Join(dir, "record.json"), append(b, '\n'), 0o640)
}

// File returns one of a machine's served files.
func (s *Store) File(name, file string) ([]byte, error) {
	if !slices.Contains(ServedFiles, file) {
		return nil, fs.ErrNotExist
	}
	return os.ReadFile(filepath.Join(s.machineDir(name), file))
}

// Records returns every machine's record.
func (s *Store) Records() ([]Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entries, err := os.ReadDir(filepath.Join(s.dir, "machines"))
	if err != nil {
		return nil, err
	}
	var out []Record
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		r, ok, err := s.record(e.Name())
		if err != nil {
			return nil, err
		}
		if ok {
			out = append(out, r)
		}
	}
	return out, nil
}

// Journal appends a verdict to verdicts.jsonl.
func (s *Store) Journal(entry any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(s.dir, "verdicts.jsonl"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o640)
	if err != nil {
		return err
	}
	if _, err := f.Write(append(b, '\n')); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// Approvals maps a serial to the EK hashes the owner approved on first intake.
type Approvals map[string][]string

func (s *Store) approvalsPath() string { return filepath.Join(s.dir, "approvals.json") }

// Approvals reads the approvals file.
func (s *Store) Approvals() (Approvals, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.approvals()
}

func (s *Store) approvals() (Approvals, error) {
	a := Approvals{}
	b, err := os.ReadFile(s.approvalsPath())
	if errors.Is(err, fs.ErrNotExist) {
		return a, nil
	}
	if err != nil {
		return nil, err
	}
	return a, json.Unmarshal(b, &a)
}

// Approve records hashes as approved for a serial.
func (s *Store) Approve(serial string, hashes []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	a, err := s.approvals()
	if err != nil {
		return err
	}
	key := serialKey(serial)
	for _, h := range hashes {
		if !slices.Contains(a[key], h) {
			a[key] = append(a[key], h)
		}
	}
	b, err := json.MarshalIndent(a, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(s.approvalsPath(), append(b, '\n'), 0o640)
}
