package attest

import (
	"context"
	"fmt"
	"os"
	"strings"

	"gopkg.in/yaml.v3"
)

// InventoryMachine is one entry of a test fixture's `machines:` document: a
// machine the harness enters into the fake NetBox. EKHash is the SHA-256 of
// the RSA EK, and EKHashECC the ECC EK's.
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

// Inventory is a test fixture: machines by their SMBIOS serial.
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

// seed enters each machine into the fake NetBox as the device its
// pins, class and status would come from.
func (inv *Inventory) seed(f *fakeNetBox) {
	for _, m := range inv.bySerial {
		status := m.Status
		if status == "" {
			status = "active"
		}
		fields := map[string]any{"talos_class": m.Class}
		if m.EKHash != "" {
			fields["ek_hash"] = m.EKHash
		}
		if m.EKHashECC != "" {
			fields["ek_hash_ecc"] = m.EKHashECC
		}
		f.add(m.Name, m.Serial, status, m.MAC, fields)
	}
}
