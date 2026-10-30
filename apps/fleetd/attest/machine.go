package attest

import (
	"context"
	"strings"
)

// Machine is what the service knows about a machine before it attests: its
// name, the facts that gate the flow and where the facts came from. NetBox
// is the source when the service has one, and the inventory fills in what
// NetBox lacks or stands alone without it.
type Machine struct {
	Name   string
	Serial string
	MAC    string
	// Class is NetBox's talos_class, the LDevID's OU.
	Class string
	// Status is NetBox's lifecycle status, such as planned or active. Empty
	// when only the inventory knows the machine.
	Status string
	// Pins are the EK hashes on record, by algorithm.
	Pins map[string]string
	// NetBoxID is the device's id, or 0 when NetBox does not know it.
	NetBoxID int
	// FromNetBox is whether NetBox answered for this machine. Only then is
	// Status its lifecycle, and only then may a planned device skip approval.
	FromNetBox bool
	// Quarantined is whether NetBox's attest_verdict is a quarantine, which
	// stands until the owner clears the verdict.
	Quarantined bool
}

// NetBox lifecycle statuses the service acts on.
const (
	statusPlanned         = "planned"
	statusFailed          = "failed"
	statusDecommissioning = "decommissioning"
	statusOffline         = "offline"
)

// MachineSource finds a machine by its SMBIOS serial.
type MachineSource interface {
	Lookup(ctx context.Context, serial string) (Machine, bool, error)
}

// lookupMachine merges the sources: NetBox's answer wins, and the inventory
// fills in a pin, a class or a MAC it lacks. When NetBox is configured and
// does not answer, the lookup fails closed: nothing is created, nothing is
// pinned, and the caller refuses without a record.
func (v *Verifier) lookupMachine(ctx context.Context, serial string) (Machine, bool, error) {
	var inv Machine
	invOK := false
	if v.Inventory != nil {
		inv, invOK, _ = v.Inventory.Lookup(ctx, serial)
	}
	if v.NetBox == nil {
		return inv, invOK, nil
	}
	nb, ok, err := v.NetBox.Lookup(ctx, serial)
	if err != nil {
		v.Log.Warn("NetBox lookup", "serial", serial, "err", err)
		return Machine{}, false, fail(reasonNetBox, "NetBox did not answer for serial %q: %v", serial, err)
	}
	if !ok {
		// A definite answer: NetBox has no such device. The inventory alone
		// never grants a planned device's pass.
		inv.FromNetBox = false
		return inv, invOK, nil
	}
	if invOK {
		if nb.MAC == "" {
			nb.MAC = inv.MAC
		}
		if nb.Class == "" {
			nb.Class = inv.Class
		}
		for alg, h := range inv.Pins {
			if nb.Pins[alg] == "" {
				if nb.Pins == nil {
					nb.Pins = map[string]string{}
				}
				nb.Pins[alg] = h
			}
		}
	}
	return nb, true, nil
}

// classControlPlane is the talos_class of the control plane, whose role
// clusters/folly/fleet/class-inputs.json names controlplane.
const classControlPlane = "controlplane"

// controlPlane reports whether the machine's class, NetBox's talos_class
// or the inventory's, is the control plane's. Quarantining such a node would
// revoke the identity of the node that serves the cluster's API and cordon
// it, so a failed running quote alerts and leaves it in place.
func (m Machine) controlPlane() bool {
	return strings.EqualFold(strings.TrimSpace(m.Class), classControlPlane)
}

// blocked reports whether the machine may get no identity: a retired one, a
// failed one until the owner moves it out of failed, and a quarantined one
// until the owner clears its verdict.
func (m Machine) blocked() bool {
	if m.Quarantined {
		return true
	}
	switch strings.ToLower(m.Status) {
	case statusDecommissioning, statusOffline, statusFailed:
		return true
	}
	return false
}

// lifecycle names what blocks the machine, for a refusal's detail.
func (m Machine) lifecycle() string {
	if m.Quarantined {
		return StatusQuarantined
	}
	return m.Status
}
