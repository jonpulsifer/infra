package fleet

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"time"
)

// SpireNode is one node the SPIRE server registers: the CN of its LDevID and
// the EK hashes its agent may attest with.
type SpireNode struct {
	Name     string   `json:"name"`
	EKHashes []string `json:"ek_hashes"`
}

// RevokedNode is a retired node whose agents the SPIRE server bans: by the
// CN of any LDevID, by the SHA-1 fingerprint of the LDevID fleetd holds, and
// by its EK hashes.
type RevokedNode struct {
	Name     string   `json:"name"`
	EKHashes []string `json:"ek_hashes"`
	LDevIDs  []string `json:"ldevids"`
}

// SpireNodes is the file the applier on the SPIRE server reads.
type SpireNodes struct {
	Nodes   []SpireNode   `json:"nodes"`
	Revoked []RevokedNode `json:"revoked"`
}

// Identity is one machine's record in fleetd's store: its LDevID's SHA-1
// fingerprint and notAfter, empty when it holds none, and its EK hashes.
type Identity struct {
	Machine     string
	Fingerprint string
	NotAfter    time.Time
	EKHashes    []string
}

var (
	spireName        = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)
	spireHash        = regexp.MustCompile(`^[0-9a-f]{64}$`)
	spireFingerprint = regexp.MustCompile(`^[0-9a-f]{40}$`)
)

// SpireNodesOf lists the devices whose identity SPIRE registers: active, with
// a passing verdict. A device that is not, because it is decommissioning,
// failed, quarantined or gone from NetBox, is absent, and the applier on the
// SPIRE server withdraws it.
//
// It also lists as revoked each machine fleetd holds a record of whose device
// is decommissioning, or absent from the devices, which are the live ones, so
// offline or deleted. Its LDevID is listed until its notAfter. An EK hash a
// registered node carries is never revoked, so a TPM that moves to a new name
// keeps its identity.
func SpireNodesOf(devices []Device, ids []Identity, now time.Time) SpireNodes {
	out := SpireNodes{Nodes: []SpireNode{}, Revoked: []RevokedNode{}}
	registered := map[string]bool{}
	byName := map[string]Device{}
	for _, d := range devices {
		byName[d.Name] = d
		if d.Status != "active" || !passedVerdict(d.Verdict) || !spireName.MatchString(d.Name) {
			continue
		}
		hashes := []string{}
		for _, h := range []string{d.EKHash, d.EKHashECC} {
			if spireHash.MatchString(h) {
				hashes = append(hashes, h)
				registered[h] = true
			}
		}
		sort.Strings(hashes)
		out.Nodes = append(out.Nodes, SpireNode{Name: d.Name, EKHashes: hashes})
	}
	sort.Slice(out.Nodes, func(a, b int) bool { return out.Nodes[a].Name < out.Nodes[b].Name })

	for _, id := range ids {
		if d, live := byName[id.Machine]; (live && d.Status != "decommissioning") || !spireName.MatchString(id.Machine) {
			continue
		}
		n := RevokedNode{Name: id.Machine, EKHashes: []string{}, LDevIDs: []string{}}
		for _, h := range id.EKHashes {
			if spireHash.MatchString(h) && !registered[h] && !slices.Contains(n.EKHashes, h) {
				n.EKHashes = append(n.EKHashes, h)
			}
		}
		sort.Strings(n.EKHashes)
		if spireFingerprint.MatchString(id.Fingerprint) && now.Before(id.NotAfter) {
			n.LDevIDs = append(n.LDevIDs, id.Fingerprint)
		}
		out.Revoked = append(out.Revoked, n)
	}
	sort.Slice(out.Revoked, func(a, b int) bool { return out.Revoked[a].Name < out.Revoked[b].Name })
	return out
}

// writeSpireNodes writes the pass's file, with no revoked node when fleetd
// keeps no identities.
func (r *Reconciler) writeSpireNodes(devices []Device) error {
	var ids []Identity
	if r.Identities != nil {
		var err error
		if ids, err = r.Identities(); err != nil {
			return err
		}
	}
	return writeSpireNodes(r.SpireNodesFile, SpireNodesOf(devices, ids, r.Now()))
}

// writeSpireNodes replaces the file with the nodes, atomically and only when
// the content changes.
func writeSpireNodes(path string, nodes SpireNodes) error {
	b, err := json.MarshalIndent(nodes, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	if old, err := os.ReadFile(path); err == nil && bytes.Equal(old, b) {
		return nil
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".spire-nodes-")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err := f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err := f.Chmod(0o644); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}
