package fleet

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
)

// SpireNode is one node the SPIRE server registers: the CN of its LDevID and
// the EK hashes its agent may attest with.
type SpireNode struct {
	Name     string   `json:"name"`
	EKHashes []string `json:"ek_hashes"`
}

type spireNodes struct {
	Nodes []SpireNode `json:"nodes"`
}

var (
	spireName = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)
	spireHash = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// SpireNodesOf lists the devices whose identity SPIRE registers: active, with
// a passing verdict. A device that is not, because it is decommissioning,
// failed, quarantined or gone from NetBox, is absent, and the applier on the
// SPIRE server withdraws it.
func SpireNodesOf(devices []Device) []SpireNode {
	nodes := []SpireNode{}
	for _, d := range devices {
		if d.Status != "active" || !passedVerdict(d.Verdict) || !spireName.MatchString(d.Name) {
			continue
		}
		hashes := []string{}
		for _, h := range []string{d.EKHash, d.EKHashECC} {
			if spireHash.MatchString(h) {
				hashes = append(hashes, h)
			}
		}
		sort.Strings(hashes)
		nodes = append(nodes, SpireNode{Name: d.Name, EKHashes: hashes})
	}
	sort.Slice(nodes, func(a, b int) bool { return nodes[a].Name < nodes[b].Name })
	return nodes
}

// writeSpireNodes replaces the file with the nodes, atomically and only when
// the content changes.
func writeSpireNodes(path string, nodes []SpireNode) error {
	b, err := json.MarshalIndent(spireNodes{Nodes: nodes}, "", "  ")
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
