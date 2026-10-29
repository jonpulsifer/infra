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
	"strings"
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
	// Class is the machine's talos_class, the LDevID's OU.
	Class string `json:"class,omitempty"`
	// The SMBIOS facts the machine claimed, for NetBox.
	Model string `json:"model,omitempty"`
	SKU   string `json:"sku,omitempty"`
	BIOS  string `json:"bios,omitempty"`
	// Renewed marks a pass that a renewal from the running node produced.
	Renewed bool `json:"renewed,omitempty"`
	// EKProven marks a pass whose session activated a credential on the EKs
	// in EKHashes: the only hashes that become pins. A renewal or a record
	// adopted from a peer carries hashes it did not prove.
	EKProven bool `json:"ek_proven,omitempty"`
	// RSAEKCert is whether the TPM holds an RSA EK certificate, the only
	// one SPIRE's tpm_devid agent reads.
	RSAEKCert      bool      `json:"rsa_ek_cert"`
	LDevIDSerial   string    `json:"ldevid_serial,omitempty"`
	LDevIDNotAfter time.Time `json:"ldevid_not_after,omitzero"`
	// LDevIDNotBefore is the certificate's CA-signed issue time: what orders
	// one attestation of a serial against another, since a peer's clock is
	// not trusted.
	LDevIDNotBefore time.Time `json:"ldevid_not_before,omitzero"`
	LAKSerial       string    `json:"lak_serial,omitempty"`
	AttestedAt      time.Time `json:"attested_at,omitzero"`
	Confirmed       bool      `json:"confirmed,omitempty"`
	NVIndexes       []uint32  `json:"nv_indexes,omitempty"`
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
	// PendingMax caps the claims that wait for approval; the oldest give way.
	// 50 when zero.
	PendingMax int
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

// machineDir is a machine's directory. A name is one path element: a
// claimed hostname or serial never reaches the filesystem as a path.
func (s *Store) machineDir(name string) (string, error) {
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, `/\`) || strings.ContainsRune(name, 0) {
		return "", fmt.Errorf("machine name %q is not one path element", name)
	}
	return filepath.Join(s.dir, "machines", name), nil
}

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
	dir, err := s.machineDir(name)
	if err != nil {
		return Record{}, false, err
	}
	b, err := os.ReadFile(filepath.Join(dir, "record.json"))
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
// a record never names files that are missing. Only an authenticated
// session, or a peer's verified pass, reaches it.
func (s *Store) Save(r Record, files map[string][]byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	dir, err := s.machineDir(r.Machine)
	if err != nil {
		return err
	}
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

// Issued is when the record's LDevID was issued, by its certificate, or
// the attestation time for a record from before that was kept.
func (r Record) IssuedAt() time.Time {
	if !r.LDevIDNotBefore.IsZero() {
		return r.LDevIDNotBefore
	}
	return r.AttestedAt
}

// NewestIssueFor is the latest LDevID issue time among every record of
// serial, and false when this anchor holds none.
func (s *Store) NewestIssueFor(serial string) (time.Time, bool, error) {
	recs, err := s.Records()
	if err != nil {
		return time.Time{}, false, err
	}
	var newest time.Time
	found := false
	for _, r := range recs {
		if serialKey(r.Serial) == serialKey(serial) && (!found || r.IssuedAt().After(newest)) {
			newest, found = r.IssuedAt(), true
		}
	}
	return newest, found, nil
}

// RetireOthers removes every other machine directory that holds serial: the
// machine was renamed, in NetBox or from its intake name, and one serial has
// one record. Only a pass calls it, since the pass proved the serial's TPM.
func (s *Store) RetireOthers(serial, keep string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	recs, err := s.records()
	if err != nil {
		return err
	}
	for _, old := range recs {
		if old.Machine == keep || serialKey(old.Serial) != serialKey(serial) {
			continue
		}
		oldDir, err := s.machineDir(old.Machine)
		if err != nil {
			return err
		}
		if err := os.RemoveAll(oldDir); err != nil {
			return fmt.Errorf("retire %s's old record: %w", old.Machine, err)
		}
	}
	return nil
}

// Pending is a first intake that waits for the owner: the EK hashes a
// machine claimed for a serial, before anything proved them. It lives apart
// from the machine records, keyed by serial, so a claim never touches an
// identity.
type Pending struct {
	Serial    string            `json:"serial"`
	Machine   string            `json:"machine,omitempty"`
	MAC       string            `json:"mac,omitempty"`
	UUID      string            `json:"uuid,omitempty"`
	EKHashes  map[string]string `json:"ek_hashes"`
	EKIssuers []string          `json:"ek_issuers,omitempty"`
	Detail    string            `json:"detail,omitempty"`
	UpdatedAt time.Time         `json:"updated_at"`
}

func (s *Store) pendingPath(serial string) string {
	return filepath.Join(s.dir, "pending", serialSlug(serial)+".json")
}

// SavePending writes the claim that waits for approval.
func (s *Store) SavePending(p Pending) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.MkdirAll(filepath.Join(s.dir, "pending"), 0o750); err != nil {
		return err
	}
	p.Serial = serialKey(p.Serial)
	// The store holds at most PendingMax claims: anyone can make one, so the
	// oldest give way to the newest, and this serial's own file is the one
	// it replaces.
	limit := s.PendingMax
	if limit <= 0 {
		limit = 50
	}
	existing, err := s.pendings()
	if err != nil {
		return err
	}
	others := existing[:0]
	for _, e := range existing {
		if serialKey(e.Serial) != p.Serial {
			others = append(others, e)
		}
	}
	sort.Slice(others, func(i, j int) bool { return others[i].UpdatedAt.Before(others[j].UpdatedAt) })
	for len(others) >= limit {
		if err := os.Remove(s.pendingPath(others[0].Serial)); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		others = others[1:]
	}
	b, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(s.pendingPath(p.Serial), append(b, '\n'), 0o640)
}

// Pending returns the claim that waits for serial, and false when none does.
// Two serials can share a slug, so the file's own serial must match.
func (s *Store) Pending(serial string) (Pending, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, err := os.ReadFile(s.pendingPath(serial))
	if errors.Is(err, fs.ErrNotExist) {
		return Pending{}, false, nil
	}
	if err != nil {
		return Pending{}, false, err
	}
	var p Pending
	if err := json.Unmarshal(b, &p); err != nil {
		return Pending{}, false, fmt.Errorf("pending %s: %w", serial, err)
	}
	if serialKey(p.Serial) != serialKey(serial) {
		return Pending{}, false, nil
	}
	return p, true, nil
}

// Pendings lists every claim that waits.
func (s *Store) Pendings() ([]Pending, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.pendings()
}

func (s *Store) pendings() ([]Pending, error) {
	entries, err := os.ReadDir(filepath.Join(s.dir, "pending"))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []Pending
	for _, e := range entries {
		b, err := os.ReadFile(filepath.Join(s.dir, "pending", e.Name()))
		if err != nil {
			return nil, err
		}
		var p Pending
		if err := json.Unmarshal(b, &p); err != nil {
			return nil, fmt.Errorf("pending %s: %w", e.Name(), err)
		}
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Serial < out[j].Serial })
	return out, nil
}

// ClearPending forgets the claim for serial, after a pass or an approval.
func (s *Store) ClearPending(serial string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.Remove(s.pendingPath(serial)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// File returns one of a machine's served files.
func (s *Store) File(name, file string) ([]byte, error) {
	if !slices.Contains(ServedFiles, file) {
		return nil, fs.ErrNotExist
	}
	dir, err := s.machineDir(name)
	if err != nil {
		return nil, err
	}
	return os.ReadFile(filepath.Join(dir, file))
}

// RecordBySerial finds the newest record whose machine has serial, and
// false when this anchor holds none.
func (s *Store) RecordBySerial(serial string) (Record, bool, error) {
	recs, err := s.Records()
	if err != nil {
		return Record{}, false, err
	}
	var out Record
	found := false
	for _, r := range recs {
		if serialKey(r.Serial) == serialKey(serial) && (!found || r.UpdatedAt.After(out.UpdatedAt)) {
			out, found = r, true
		}
	}
	return out, found, nil
}

// Records returns every machine's record.
func (s *Store) Records() ([]Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.records()
}

func (s *Store) records() ([]Record, error) {
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
