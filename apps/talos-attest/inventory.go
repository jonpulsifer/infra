package main

import (
	"fmt"
	"os"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// InventoryMachine is the part of clusters/folly/inventory/machines.yaml this
// service reads. EKHash is the SHA-256 of the RSA EK, the value SPIRE's TPM
// plugin uses; EKHashECC is the ECC EK's.
type InventoryMachine struct {
	Name       string `yaml:"-"`
	Serial     string `yaml:"serial"`
	MAC        string `yaml:"mac"`
	TPM        string `yaml:"tpm"`
	SecureBoot bool   `yaml:"secure_boot"`
	EKHash     string `yaml:"ek_hash"`
	EKHashECC  string `yaml:"ek_hash_ecc"`
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

// LoadInventory reads machines.yaml.
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

func serialKey(s string) string { return strings.ToUpper(strings.TrimSpace(s)) }

// BySerial looks a machine up by its SMBIOS serial.
func (inv *Inventory) BySerial(serial string) (InventoryMachine, bool) {
	m, ok := inv.bySerial[serialKey(serial)]
	return m, ok
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
