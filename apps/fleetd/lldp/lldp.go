// Package lldp reads the switch port a NIC is plugged into from the LLDP
// frame the switch sends it, for the attest action to report under the
// session's AK. A UniFi switch sends one every 30 seconds, with its MAC as
// the chassis ID and "Port <n>" as the port ID.
//
// It is a copy of the parser in images/tink-agent-autoid/intake, whose
// Docker context cannot reach this module; change both together.
package lldp

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/jonpulsifer/infra/apps/fleetd/protocol"
)

const (
	etherTypeLLDP = 0x88cc
	// Wait outlasts one 30-second transmit interval.
	Wait    = 35 * time.Second
	maxText = 255
	// packetMulticast is the kernel's PACKET_MULTICAST, the sll_pkttype of
	// a frame to a multicast group the NIC received.
	packetMulticast = 2
)

// group is the nearest-bridge address, which no bridge forwards.
var group = [6]byte{0x01, 0x80, 0xc2, 0x00, 0x00, 0x0e}

var errNotLLDP = errors.New("not an LLDP frame")

// fromSwitch says whether a raw socket's frame is one the switch sent the
// NIC: received, not sent by this host or seen in promiscuous mode, and to
// the nearest-bridge group.
func fromSwitch(frame []byte, pkttype uint8) bool {
	return pkttype == packetMulticast && len(frame) >= 6 && [6]byte(frame[:6]) == group
}

// Parse reads an Ethernet frame as an AF_PACKET raw socket delivers it, with
// an 802.1Q or 802.1ad tag or without.
func Parse(frame []byte) (protocol.LLDP, error) {
	off := 12
	for {
		if len(frame) < off+2 {
			return protocol.LLDP{}, errNotLLDP
		}
		switch binary.BigEndian.Uint16(frame[off:]) {
		case 0x8100, 0x88a8:
			off += 4
			continue
		case etherTypeLLDP:
			return parseLLDPDU(frame[off+2:])
		}
		return protocol.LLDP{}, errNotLLDP
	}
}

// parseLLDPDU reads the TLVs up to the End TLV. A frame without a chassis ID
// and a port ID is no answer.
func parseLLDPDU(b []byte) (protocol.LLDP, error) {
	var l protocol.LLDP
	for len(b) >= 2 {
		header := binary.BigEndian.Uint16(b)
		typ, n := header>>9, int(header&0x1ff)
		b = b[2:]
		if n > len(b) {
			return protocol.LLDP{}, fmt.Errorf("TLV %d is %d bytes, %d remain", typ, n, len(b))
		}
		v := b[:n]
		b = b[n:]
		switch typ {
		case 0:
			b = nil
		case 1:
			if n < 2 {
				return protocol.LLDP{}, errors.New("an empty chassis ID")
			}
			l.ChassisID = id(v[0], v[1:], 4, 5)
		case 2:
			if n < 2 {
				return protocol.LLDP{}, errors.New("an empty port ID")
			}
			l.PortID = id(v[0], v[1:], 3, 4)
		case 4:
			l.PortDescription = text(v)
		case 5:
			l.SystemName = text(v)
		}
	}
	if l.ChassisID == "" || l.PortID == "" {
		return protocol.LLDP{}, errors.New("no chassis ID or port ID")
	}
	return l, nil
}

// id renders a chassis or port ID by its subtype: a MAC as
// aa:bb:cc:dd:ee:ff, a network address as an IP, anything else as text.
func id(subtype byte, v []byte, macSubtype, addrSubtype byte) string {
	switch {
	case subtype == macSubtype && len(v) == 6:
		return net.HardwareAddr(v).String()
	case subtype == addrSubtype && len(v) > 1:
		if a, ok := netip.AddrFromSlice(v[1:]); ok && (v[0] == 1 && a.Is4() || v[0] == 2 && a.Is6()) {
			return a.String()
		}
	}
	return text(v)
}

// text keeps printable ASCII and marks every other byte with "?".
func text(v []byte) string {
	if len(v) > maxText {
		v = v[:maxText]
	}
	out := make([]byte, len(v))
	for i, c := range v {
		if c < 0x20 || c > 0x7e {
			c = '?'
		}
		out[i] = c
	}
	return strings.TrimSpace(string(out))
}

// Interface is the name of the NIC with the MAC under a sysfs root: a
// physical one first, since a bridge or bond can carry its member's MAC.
func Interface(sys, mac string) string {
	if mac == "" {
		return ""
	}
	entries, _ := os.ReadDir(filepath.Join(sys, "class/net"))
	other := ""
	for _, e := range entries {
		dir := filepath.Join(sys, "class/net", e.Name())
		b, err := os.ReadFile(filepath.Join(dir, "address"))
		if err != nil || !strings.EqualFold(strings.TrimSpace(string(b)), mac) {
			continue
		}
		if _, err := os.Stat(filepath.Join(dir, "device")); err == nil {
			return e.Name()
		}
		if other == "" {
			other = e.Name()
		}
	}
	return other
}

// Address is the NIC's first global IPv4 address, or "".
func Address(ifname string) string {
	iface, err := net.InterfaceByName(ifname)
	if err != nil {
		return ""
	}
	addrs, err := iface.Addrs()
	if err != nil {
		return ""
	}
	for _, a := range addrs {
		p, err := netip.ParsePrefix(a.String())
		if err == nil && p.Addr().Is4() && p.Addr().IsGlobalUnicast() {
			return p.Addr().String()
		}
	}
	return ""
}
