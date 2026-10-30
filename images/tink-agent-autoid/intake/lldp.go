package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// LLDP is what the switch says of the port the machine is plugged into, from one LLDP frame: the
// switch's chassis ID and system name, and the port's ID and description. A UniFi switch sends one
// every 30 seconds, with its MAC as the chassis ID and "Port <n>" as the port ID.
type LLDP struct {
	ChassisID       string `json:"chassis_id"`
	PortID          string `json:"port_id"`
	PortDescription string `json:"port_description,omitempty"`
	SystemName      string `json:"system_name,omitempty"`
}

const (
	etherTypeLLDP = 0x88cc
	// lldpWait outlasts one 30-second transmit interval, and bounds the post's delay on a switch
	// with LLDP off.
	lldpWait = 35 * time.Second
	maxText  = 255
)

// lldpGroup is the nearest-bridge address, which no bridge forwards.
var lldpGroup = [6]byte{0x01, 0x80, 0xc2, 0x00, 0x00, 0x0e}

var errNotLLDP = errors.New("not an LLDP frame")

// packetMulticast is the kernel's PACKET_MULTICAST, the sll_pkttype of a
// frame to a multicast group the NIC received.
const packetMulticast = 2

// fromSwitch says whether a raw socket's frame is one the switch sent the
// NIC: received, not sent by this host or seen in promiscuous mode, and to
// the nearest-bridge group.
func fromSwitch(frame []byte, pkttype uint8) bool {
	return pkttype == packetMulticast && len(frame) >= 6 && [6]byte(frame[:6]) == lldpGroup
}

// parseFrame reads an Ethernet frame as an AF_PACKET raw socket delivers it, with an 802.1Q or
// 802.1ad tag or without.
func parseFrame(frame []byte) (LLDP, error) {
	off := 12
	for {
		if len(frame) < off+2 {
			return LLDP{}, errNotLLDP
		}
		switch binary.BigEndian.Uint16(frame[off:]) {
		case 0x8100, 0x88a8:
			off += 4
			continue
		case etherTypeLLDP:
			return parseLLDPDU(frame[off+2:])
		}
		return LLDP{}, errNotLLDP
	}
}

// parseLLDPDU reads the TLVs up to the End TLV. A frame without a chassis ID and a port ID is no
// answer.
func parseLLDPDU(b []byte) (LLDP, error) {
	var l LLDP
	for len(b) >= 2 {
		header := binary.BigEndian.Uint16(b)
		typ, n := header>>9, int(header&0x1ff)
		b = b[2:]
		if n > len(b) {
			return LLDP{}, fmt.Errorf("TLV %d is %d bytes, %d remain", typ, n, len(b))
		}
		v := b[:n]
		b = b[n:]
		switch typ {
		case 0:
			b = nil
		case 1:
			if n < 2 {
				return LLDP{}, errors.New("an empty chassis ID")
			}
			l.ChassisID = id(v[0], v[1:], 4, 5)
		case 2:
			if n < 2 {
				return LLDP{}, errors.New("an empty port ID")
			}
			l.PortID = id(v[0], v[1:], 3, 4)
		case 4:
			l.PortDescription = text(v)
		case 5:
			l.SystemName = text(v)
		}
	}
	if l.ChassisID == "" || l.PortID == "" {
		return LLDP{}, errors.New("no chassis ID or port ID")
	}
	return l, nil
}

// id renders a chassis or port ID by its subtype: a MAC as aa:bb:cc:dd:ee:ff, a network address
// as an IP, anything else as text.
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

// text keeps printable ASCII and marks every other byte with "?", so the controller, which takes
// only printable ASCII, never refuses a switch's port name.
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

// interfaceFor is the name of the NIC with the MAC: a physical one first, since a bridge or bond
// can carry its member's MAC.
func interfaceFor(sys, mac string) string {
	entries, _ := os.ReadDir(filepath.Join(sys, "class/net"))
	other := ""
	for _, e := range entries {
		dir := filepath.Join(sys, "class/net", e.Name())
		if !strings.EqualFold(read(filepath.Join(dir, "address")), mac) {
			continue
		}
		if exists(filepath.Join(dir, "device")) {
			return e.Name()
		}
		if other == "" {
			other = e.Name()
		}
	}
	return other
}

// neighbour listens on the boot NIC for the switch's LLDP frame, for at most wait, and logs what
// it heard. No frame, or no socket, is no LLDP: the intake goes without it.
func neighbour(sys, mac string, wait time.Duration, log io.Writer) *LLDP {
	ifname := interfaceFor(sys, mac)
	if ifname == "" {
		fmt.Fprintf(log, "fleet-intake: no LLDP: no NIC has the MAC %s\n", mac)
		return nil
	}
	l, err := listenLLDP(ifname, wait)
	if err != nil {
		fmt.Fprintf(log, "fleet-intake: no LLDP: %v\n", err)
		return nil
	}
	fmt.Fprintf(log, "fleet-intake: LLDP on %s: %s port %q (%s)\n", ifname, l.ChassisID, l.PortID, l.SystemName)
	return &l
}
