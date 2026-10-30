package lldp

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"

	"github.com/jonpulsifer/infra/apps/talos-attest/protocol"
)

func TestInterface(t *testing.T) {
	sys := t.TempDir()
	nic := func(name, mac string, physical bool) {
		dir := filepath.Join(sys, "class/net", name)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "address"), []byte(mac+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		if physical {
			if err := os.Mkdir(filepath.Join(dir, "device"), 0o755); err != nil {
				t.Fatal(err)
			}
		}
	}
	nic("br0", "aa:bb:cc:00:00:02", false)
	nic("enp3s0", "aa:bb:cc:00:00:02", true)
	nic("docker0", "02:42:ac:11:00:01", false)
	for mac, want := range map[string]string{"AA:BB:CC:00:00:02": "enp3s0", "02:42:ac:11:00:01": "docker0", "aa:bb:cc:00:00:09": "", "": ""} {
		if got := Interface(sys, mac); got != want {
			t.Errorf("Interface(%s) = %q, want %q", mac, got, want)
		}
	}
}

func tlv(typ int, value ...byte) []byte {
	b := binary.BigEndian.AppendUint16(nil, uint16(typ)<<9|uint16(len(value)))
	return append(b, value...)
}

func cat(parts ...[]byte) []byte { return bytes.Join(parts, nil) }

// uswFrame is shaped after a frame a USW-24-PoE sent an anchor's NIC, with its addresses replaced:
// a MAC chassis ID, a local port ID "Port <n>", the TTL, two LLDP-MED TLVs, the port's name as
// its description, the system name and description, capabilities, three management addresses
// and the port VLAN.
func uswFrame(port, description string) []byte {
	chassis := []byte{0x02, 0x00, 0x00, 0x00, 0x24, 0x01}
	return cat(
		[]byte{0x01, 0x80, 0xc2, 0x00, 0x00, 0x0e, 0x02, 0x00, 0x00, 0x00, 0x24, 0x02, 0x88, 0xcc},
		tlv(1, append([]byte{4}, chassis...)...),
		tlv(2, append([]byte{7}, port...)...),
		tlv(3, 0x00, 0x78),
		tlv(127, 0x00, 0x12, 0xbb, 0x01, 0x00, 0x09, 0x04),
		tlv(127, 0x00, 0x12, 0xbb, 0x04, 0x12, 0x00, 0xff),
		tlv(4, []byte(description)...),
		tlv(5, []byte("USW-24-PoE")...),
		tlv(6, []byte("UBNT-USL24")...),
		tlv(7, 0x00, 0x04, 0x00, 0x04),
		tlv(8, 0x05, 0x01, 192, 0, 2, 231, 0x03, 0, 0, 0, 0, 0),
		tlv(8, cat([]byte{0x11, 0x02}, bytes.Repeat([]byte{0x20}, 16), []byte{0x03, 0, 0, 0, 0, 0})...),
		tlv(127, 0x00, 0x80, 0xc2, 0x01, 0x00, 0x02),
		tlv(0),
	)
}

func TestParseFrame(t *testing.T) {
	want := protocol.LLDP{ChassisID: "02:00:00:00:24:01", PortID: "Port 7", PortDescription: "spore", SystemName: "USW-24-PoE"}
	got, err := Parse(uswFrame("Port 7", "spore"))
	if err != nil || got != want {
		t.Fatalf("got %+v, %v", got, err)
	}

	tagged := uswFrame("Port 24", "provisioning")
	tagged = cat(tagged[:12], []byte{0x81, 0x00, 0x00, 0x02}, tagged[12:])
	if got, err := Parse(tagged); err != nil || got.PortID != "Port 24" || got.PortDescription != "provisioning" {
		t.Errorf("an 802.1Q-tagged frame: %+v, %v", got, err)
	}
}

func TestFromSwitch(t *testing.T) {
	frame := uswFrame("Port 7", "spore")
	if !fromSwitch(frame, packetMulticast) {
		t.Error("a received frame to the nearest-bridge group was refused")
	}
	for name, c := range map[string]struct {
		frame   []byte
		pkttype uint8
	}{
		"sent by this host":   {frame, 4},
		"promiscuous":         {frame, 3},
		"unicast to the host": {frame, 0},
		"another group":       {cat([]byte{0x01, 0x80, 0xc2, 0x00, 0x00, 0x03}, frame[6:]), packetMulticast},
		"runt":                {frame[:5], packetMulticast},
	} {
		if fromSwitch(c.frame, c.pkttype) {
			t.Errorf("%s was accepted", name)
		}
	}
}

func TestParseFrameIDSubtypes(t *testing.T) {
	head := []byte{0x01, 0x80, 0xc2, 0x00, 0x00, 0x0e, 0x02, 0, 0, 0, 0, 0x02, 0x88, 0xcc}
	frame := cat(head,
		tlv(1, 5, 1, 192, 0, 2, 7),
		tlv(2, 3, 0x02, 0, 0, 0, 0x24, 0x07),
		tlv(4, 'P', 'o', 'r', 't', ' ', 0xc3, 0xa9),
		tlv(0),
		tlv(5, []byte("after the end")...),
	)
	got, err := Parse(frame)
	want := protocol.LLDP{ChassisID: "192.0.2.7", PortID: "02:00:00:00:24:07", PortDescription: "Port ??"}
	if err != nil || got != want {
		t.Errorf("got %+v, %v", got, err)
	}
}

func TestParseFrameRefuses(t *testing.T) {
	good := uswFrame("Port 7", "spore")
	ipv4 := append(append([]byte{}, good[:12]...), 0x08, 0x00)
	for name, frame := range map[string][]byte{
		"runt":           good[:13],
		"another type":   append(ipv4, good[14:]...),
		"truncated TLV":  good[:20],
		"no port ID":     cat(good[:14], tlv(1, 4, 2, 0, 0, 0, 0, 1), tlv(0)),
		"empty chassis":  cat(good[:14], tlv(1), tlv(2, 7, '1'), tlv(0)),
		"only the End":   cat(good[:14], tlv(0)),
		"length overrun": cat(good[:14], []byte{0x02, 0xff, 0x07}),
	} {
		if got, err := Parse(frame); err == nil {
			t.Errorf("%s parsed: %+v", name, got)
		}
	}
}
