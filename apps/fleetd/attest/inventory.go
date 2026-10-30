package attest

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// InventoryMachine is one entry of the inventory ATTEST_INVENTORY names, a
// `machines:` document that nix/services/fleetd.nix writes from the nodes
// file, clusters/folly/inventory/nodes.yaml: each node's serial, class, TPM
// version and Secure Boot state. EKHash is the SHA-256 of the RSA EK, the
// value SPIRE's TPM plugin uses, and EKHashECC the ECC EK's; the nodes file
// carries neither, since NetBox holds the pins.
type InventoryMachine struct {
	Name       string `yaml:"-"`
	Serial     string `yaml:"serial"`
	MAC        string `yaml:"mac"`
	TPM        string `yaml:"tpm"`
	SecureBoot bool   `yaml:"secure_boot"`
	EKHash     string `yaml:"ek_hash"`
	EKHashECC  string `yaml:"ek_hash_ecc"`
	Class      string `yaml:"class"`
	Status     string `yaml:"status"`
}

// Pinned returns the EK hashes the inventory records, by algorithm.
func (m InventoryMachine) Pinned() map[string]string {
	p := map[string]string{}
	if m.EKHash != "" {
		p["rsa"] = strings.ToLower(m.EKHash)
	}
	if m.EKHashECC != "" {
		p["ecc"] = strings.ToLower(m.EKHashECC)
	}
	return p
}

// Inventory finds machines by their SMBIOS serial.
type Inventory struct {
	bySerial map[string]InventoryMachine
}

// LoadInventory reads the inventory at path.
func LoadInventory(path string) (*Inventory, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var doc struct {
		Machines map[string]InventoryMachine `yaml:"machines"`
	}
	if err := yaml.Unmarshal(b, &doc); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	inv := &Inventory{bySerial: map[string]InventoryMachine{}}
	for name, m := range doc.Machines {
		m.Name = name
		if m.Serial == "" {
			continue
		}
		key := serialKey(m.Serial)
		if other, dup := inv.bySerial[key]; dup {
			return nil, fmt.Errorf("%s: %s and %s share serial %s", path, other.Name, name, m.Serial)
		}
		inv.bySerial[key] = m
	}
	return inv, nil
}

// serialKey normalizes a serial for comparison: ASCII upper case, with the
// surrounding white space trimmed, and nothing else. validSerial has
// refused anything outside printable ASCII before a serial gets this far.
func serialKey(s string) string {
	b := []byte(strings.TrimSpace(s))
	for i, c := range b {
		if c >= 'a' && c <= 'z' {
			b[i] = c - 'a' + 'A'
		}
	}
	return string(b)
}

// validSerial is whether a claimed serial is printable ASCII and not empty.
func validSerial(s string) bool {
	s = strings.TrimSpace(s)
	if s == "" || len(s) > 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < 0x21 || s[i] > 0x7e {
			return false
		}
	}
	return true
}

// BySerial looks a machine up by its SMBIOS serial.
func (inv *Inventory) BySerial(serial string) (InventoryMachine, bool) {
	m, ok := inv.bySerial[serialKey(serial)]
	return m, ok
}

// Lookup implements MachineSource.
func (inv *Inventory) Lookup(_ context.Context, serial string) (Machine, bool, error) {
	m, ok := inv.BySerial(serial)
	if !ok {
		return Machine{}, false, nil
	}
	return Machine{Name: m.Name, Serial: m.Serial, MAC: m.MAC, Class: m.Class, Status: m.Status, Pins: m.Pinned()}, true, nil
}

// Names lists the machines with a serial.
func (inv *Inventory) Names() []string {
	out := make([]string, 0, len(inv.bySerial))
	for _, m := range inv.bySerial {
		out = append(out, m.Name)
	}
	sort.Strings(out)
	return out
}
