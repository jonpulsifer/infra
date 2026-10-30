//go:build cgo

// The network facts on the software TPM: an intake pass records the address
// and switch port its AK signed, and nothing a host on the way rewrote.

package main

import (
	"context"
	"strings"
	"testing"

	"github.com/jonpulsifer/infra/apps/talos-attest/client"
	"github.com/jonpulsifer/infra/apps/talos-attest/protocol"
)

// The harness's requests come from 127.0.0.1, its TCP peer.
var simNetwork = protocol.Network{
	Address: "127.0.0.1",
	LLDP:    &protocol.LLDP{ChassisID: "02:00:00:00:24:01", PortID: "Port 12", PortDescription: "surge", SystemName: "USW-24-PoE"},
}

var simNetworkFields = map[string]any{"attested_address": nil, "attested_switch": nil, "attested_switch_port": nil, "attested_network_at": nil}

func (h *harness) runWithNetwork(n *protocol.Network) error {
	_, err := client.Run(context.Background(), h.sim, client.Config{
		BaseURL:  h.ts.URL,
		Machine:  simClaim,
		EventLog: h.eventLog,
		StoreNV:  true,
		Network:  func() *protocol.Network { return n },
	})
	return err
}

func plannedWithNetworkFields(f *fakeNetBox, preset map[string]any) {
	fields := map[string]any{"talos_class": "worker-g5"}
	for k, v := range simNetworkFields {
		fields[k] = v
	}
	for k, v := range preset {
		fields[k] = v
	}
	f.add("testbox", simSerial, "planned", simMAC, fields)
}

func TestPassRecordsTheSignedNetwork(t *testing.T) {
	f := newFakeNetBox(t)
	h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
	plannedWithNetworkFields(f, nil)
	if err := h.runWithNetwork(&simNetwork); err != nil {
		t.Fatal(err)
	}
	cf := f.settled(t, simSerial, 2).CustomFields
	if cf["attested_address"] != "127.0.0.1" || cf["attested_switch"] != "02:00:00:00:24:01" || cf["attested_switch_port"] != "Port 12" || cf["attested_network_at"] != cf["last_attested"] {
		t.Fatalf("NetBox after the pass: %+v", cf)
	}
	if rec, ok, _ := h.v.Store.Record("testbox"); !ok || rec.Network == nil || rec.Network.Address != "127.0.0.1" {
		t.Fatalf("the record holds %+v", rec.Network)
	}
}

// A machine's AK signs an address that is not the one its evidence came
// from, as when it names another box's lease: the address is dropped, the
// port stays, and the device's journal says why.
func TestAttestedAddressMustBeTheSource(t *testing.T) {
	f := newFakeNetBox(t)
	h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
	plannedWithNetworkFields(f, nil)
	n := simNetwork
	n.Address = "192.0.2.5"
	if err := h.runWithNetwork(&n); err != nil {
		t.Fatal(err)
	}
	cf := f.settled(t, simSerial, 2).CustomFields
	if cf["attested_address"] != nil || cf["attested_switch_port"] != "Port 12" || cf["attested_network_at"] == nil {
		t.Fatalf("NetBox after the pass: %+v", cf)
	}
	waitFor(t, "the journal entry", func() bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		for _, j := range f.journal {
			if strings.Contains(j, "the attested address 192.0.2.5 is not the address the evidence came from (127.0.0.1)") {
				return true
			}
		}
		return false
	})
}

// A host between the machine and the service rewrites the address and the
// port, or strips the signature: the pass stands, and NetBox keeps no
// network fact the TPM did not sign.
func TestForgedNetworkIsNotRecorded(t *testing.T) {
	for name, tamper := range map[string]func(*protocol.EvidenceRequest){
		"address": func(r *protocol.EvidenceRequest) { r.Network.Address = "192.0.2.66" },
		"port":    func(r *protocol.EvidenceRequest) { r.Network.LLDP.PortID = "Port 7" },
		"unsigned": func(r *protocol.EvidenceRequest) {
			r.NetworkSignature = nil
		},
		"added": func(r *protocol.EvidenceRequest) {
			r.Network = &protocol.Network{Address: "192.0.2.66"}
			r.NetworkSignature = nil
		},
	} {
		t.Run(name, func(t *testing.T) {
			f := newFakeNetBox(t)
			h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
			plannedWithNetworkFields(f, map[string]any{"attested_address": "192.0.2.9", "attested_network_at": "2026-10-01T00:00:00Z"})
			h.tamper = tamper
			n := simNetwork
			l := *simNetwork.LLDP
			n.LLDP = &l
			sent := &n
			if name == "added" {
				sent = nil
			}
			if err := h.runWithNetwork(sent); err != nil {
				t.Fatal(err)
			}
			cf := f.settled(t, simSerial, 2).CustomFields
			if cf["attested_address"] != nil || cf["attested_switch_port"] != nil || cf["attested_network_at"] != nil || cf["attest_verdict"] != StatusAttested {
				t.Fatalf("NetBox after a forged network: %+v", cf)
			}
		})
	}
}

func TestNetworkWaitsForTheFields(t *testing.T) {
	f := newFakeNetBox(t)
	h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
	f.add("testbox", simSerial, "planned", simMAC, map[string]any{"talos_class": "worker-g5"})
	if err := h.runWithNetwork(&simNetwork); err != nil {
		t.Fatal(err)
	}
	cf := f.settled(t, simSerial, 2).CustomFields
	if _, ok := cf["attested_address"]; ok || cf["attest_verdict"] != StatusAttested {
		t.Fatalf("NetBox after the pass: %+v", cf)
	}
}
