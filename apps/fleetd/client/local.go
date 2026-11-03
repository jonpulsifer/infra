package client

import (
	"os"
	"strings"

	"github.com/jonpulsifer/infra/apps/fleetd/lldp"
	"github.com/jonpulsifer/infra/apps/fleetd/protocol"
)

// ReadTrim is a sysfs or procfs file's contents without surrounding space,
// or "" when it cannot be read.
func ReadTrim(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// LocalMachine is what this host says about itself: the serial and UUID
// given, the MAC of the NIC it booted from, and the rest from SMBIOS.
func LocalMachine(serial, uuid, mac string) protocol.Machine {
	return protocol.Machine{
		Serial:       serial,
		UUID:         uuid,
		MAC:          mac,
		Hostname:     ReadTrim("/proc/sys/kernel/hostname"),
		Manufacturer: ReadTrim("/sys/class/dmi/id/sys_vendor"),
		Model:        ReadTrim("/sys/class/dmi/id/product_name"),
		SKU:          ReadTrim("/sys/class/dmi/id/product_sku"),
		BIOS:         ReadTrim("/sys/class/dmi/id/bios_version"),
	}
}

// Network starts listening on the NIC with the MAC and answers what it
// found when asked: the NIC's address, and the switch's LLDP neighbour when
// a frame arrived. A NIC the caller cannot see, as without the host's
// network namespace, gives nothing.
func Network(mac string, logf func(string, ...any)) func() *protocol.Network {
	ifname := lldp.Interface("/sys", mac)
	if ifname == "" {
		logf("no NIC has the MAC %q; no network facts", mac)
		return func() *protocol.Network { return nil }
	}
	heard := make(chan *protocol.LLDP, 1)
	go func() {
		l, err := lldp.Listen(ifname, lldp.Wait)
		if err != nil {
			logf("no LLDP: %v", err)
			heard <- nil
			return
		}
		logf("LLDP on %s: %s port %q (%s)", ifname, l.ChassisID, l.PortID, l.SystemName)
		heard <- &l
	}()
	return func() *protocol.Network {
		n := &protocol.Network{LLDP: <-heard, Address: lldp.Address(ifname)}
		logf("network: %s address %q", ifname, n.Address)
		return n
	}
}
