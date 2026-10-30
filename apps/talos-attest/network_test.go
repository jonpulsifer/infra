package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/go-attestation/attest"
	"github.com/google/go-tpm/legacy/tpm2"

	"github.com/jonpulsifer/infra/apps/talos-attest/protocol"
)

func signNetwork(t *testing.T, key *ecdsa.PrivateKey, nonce []byte, n protocol.Network) []byte {
	t.Helper()
	r, s, err := ecdsa.Sign(rand.Reader, key, protocol.NetworkDigest(nonce, n))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := tpm2.Signature{Alg: tpm2.AlgECDSA, ECC: &tpm2.SignatureECC{HashAlg: tpm2.AlgSHA256, R: r, S: s}}.Encode()
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestNetworkSigned(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	other, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	nonce := []byte("0123456789abcdef0123456789abcdef")
	s := &session{ak: &attest.AKPublic{Public: &key.PublicKey}, nonce: nonce}
	n := protocol.Network{Address: "192.0.2.5", LLDP: &protocol.LLDP{ChassisID: "02:00:00:00:24:01", PortID: "Port 12"}}
	good := signNetwork(t, key, nonce, n)
	if err := networkSigned(s, n, good); err != nil {
		t.Fatalf("the AK's signature: %v", err)
	}
	forged := n
	forged.Address = "192.0.2.66"
	otherPort := n
	otherPort.LLDP = &protocol.LLDP{ChassisID: "02:00:00:00:24:01", PortID: "Port 7"}
	for name, c := range map[string]struct {
		n   protocol.Network
		sig []byte
	}{
		"another address":       {forged, good},
		"another port":          {otherPort, good},
		"another key":           {n, signNetwork(t, other, nonce, n)},
		"another session nonce": {n, signNetwork(t, key, []byte("another nonce"), n)},
		"unsigned":              {n, nil},
		"garbage":               {n, []byte{1, 2, 3}},
	} {
		if err := networkSigned(s, c.n, c.sig); err == nil {
			t.Errorf("%s verified", name)
		}
	}
}

// A renewal from the running node says nothing of where it is plugged in:
// the network fields of its last intake pass stay as they are.
func TestNetBoxRenewalLeavesTheNetworkFields(t *testing.T) {
	f := newFakeNetBox(t)
	nb := f.client()
	on := map[string]any{"attested_address": "192.0.2.5", "attested_switch": "02:00:00:00:24:01", "attested_switch_port": "Port 12", "attested_network_at": "2026-10-29T02:00:00Z"}
	fields := map[string]any{}
	for k, v := range on {
		fields[k] = v
	}
	f.add("swell", "SW-1", "active", "aa:bb:cc:dd:ee:01", fields)
	now := time.Date(2026, 10, 30, 2, 0, 0, 0, time.UTC)
	renewal := Record{Machine: "swell", Serial: "SW-1", Status: StatusAttested, Renewed: true, LDevIDSerial: "0c", LAKSerial: "0d", AttestedAt: now, LDevIDNotAfter: now.Add(90 * 24 * time.Hour)}
	if err := nb.Record(context.Background(), renewal); err != nil {
		t.Fatal(err)
	}
	cf := f.bySerial("SW-1").CustomFields
	for k, v := range on {
		if cf[k] != v {
			t.Errorf("after a renewal %s = %v, want %v", k, cf[k], v)
		}
	}
	if cf["ldevid_serial"] != "0c" {
		t.Errorf("the renewal was not recorded: %+v", cf)
	}
}

func TestClientAddress(t *testing.T) {
	for _, c := range []struct {
		peer, real, want string
	}{
		// The unix socket that only nginx reaches: its header names the machine.
		{"@", "192.0.2.5", "192.0.2.5"},
		{"", "192.0.2.5", "192.0.2.5"},
		{"@", "", ""},
		{"@", "bogus", ""},
		// A TCP peer is the address, and its header is a claim.
		{"192.0.2.7:40000", "192.0.2.5", "192.0.2.7"},
		{"[::ffff:192.0.2.7]:40000", "", "192.0.2.7"},
	} {
		r := httptest.NewRequest(http.MethodPost, "/v1/attest/x/evidence", nil)
		r.RemoteAddr = c.peer
		if c.real != "" {
			r.Header.Set("X-Real-IP", c.real)
		}
		if got := clientAddress(r); got != c.want {
			t.Errorf("peer %q, X-Real-IP %q: %q, want %q", c.peer, c.real, got, c.want)
		}
	}
}

func TestCleanNetwork(t *testing.T) {
	got := cleanNetwork(protocol.Network{Address: "2001:db8::1", LLDP: &protocol.LLDP{ChassisID: "x", PortID: "Port\x01"}})
	if got.Address != "" || got.LLDP != nil {
		t.Errorf("kept %+v", got)
	}
	got = cleanNetwork(protocol.Network{Address: "192.0.2.5", LLDP: &protocol.LLDP{ChassisID: "x"}})
	if got.Address != "192.0.2.5" || got.LLDP != nil {
		t.Errorf("kept %+v", got)
	}
}
