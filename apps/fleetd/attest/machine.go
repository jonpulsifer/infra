package attest

import (
	"context"
	"strings"
)

// Machine is what the service knows about a machine before it attests: its
// name, the facts that gate the flow and where the facts came from. NetBox
// is the only source.
type Machine struct {
	Name   string
	Serial string
	MAC    string
	// Class is NetBox's talos_class, the LDevID's OU.
	Class string
	// Status is NetBox's lifecycle status, such as planned or active.
	Status string
	// Pins are the EK hashes fleetd observed and proved, by algorithm.
	Pins map[string]string
	// Approved is the approved binding, by algorithm: the EK hashes git
	// declares for the device, which only the owner changes.
	Approved map[string]string
	// NetBoxID is the device's id, or 0 when NetBox does not know it.
	NetBoxID int
	// FromNetBox is whether NetBox answered for this machine.
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

// lookupMachine asks NetBox for the machine. A NetBox that does not answer
// fails closed: nothing is created, nothing is pinned, and the caller
// refuses without a record. A NetBox that has no such device is a definite
// no, and the claim waits for a node entry in git.
func (v *Verifier) lookupMachine(ctx context.Context, serial string) (Machine, bool, error) {
	nb, ok, err := v.NetBox.Lookup(ctx, serial)
	if err != nil {
		v.Log.Warn("NetBox lookup", "serial", serial, "err", err)
		return Machine{}, false, fail(reasonNetBox, "NetBox did not answer for serial %q: %v", serial, err)
	}
	return nb, ok, nil
}

// classControlPlane is the talos_class of the control plane, whose role
// clusters/folly/fleet/class-inputs.json names controlplane.
const classControlPlane = "controlplane"

// controlPlane reports whether the machine's class, NetBox's talos_class, is the control plane's. Quarantining such a node would
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
