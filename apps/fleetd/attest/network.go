package attest

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"strings"

	"github.com/google/go-tpm/legacy/tpm2"

	"github.com/jonpulsifer/infra/apps/fleetd/protocol"
)

type clientKey struct{}

// withClient carries the address an evidence request came from to the
// Verifier.
func withClient(ctx context.Context, addr string) context.Context {
	return context.WithValue(ctx, clientKey{}, addr)
}

func clientOf(ctx context.Context) string {
	s, _ := ctx.Value(clientKey{}).(string)
	return s
}

// clientAddress is the address a request came from: its TCP peer, or, on a
// unix socket that only a local proxy reaches, the X-Real-IP header the
// proxy sets from its peer. fleetd serves the device flow on TCP, so a
// TCP peer's X-Real-IP is ignored: any caller can send one. It is "" when
// neither names an address.
func clientAddress(r *http.Request) string {
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		if a, err := netip.ParseAddr(host); err == nil {
			return a.Unmap().String()
		}
	}
	if a, err := netip.ParseAddr(strings.TrimSpace(r.Header.Get("X-Real-IP"))); err == nil {
		return a.Unmap().String()
	}
	return ""
}

// attestedNetwork is the evidence's network facts when the session's AK
// signed them, with what is malformed dropped, or nil. Unsigned facts, or
// facts the AK did not sign, are logged and never recorded: fleetd cables a
// machine to the port and checks it against the device's expected_port, so
// only the TPM that passed may speak for them. The address must also be the
// one the evidence came from, so a machine never names another's lease; one
// that is not is dropped, the port kept, and the device's journal says why.
func (v *Verifier) attestedNetwork(ctx context.Context, s *session, req protocol.EvidenceRequest) *protocol.Network {
	if req.Network == nil {
		return nil
	}
	if err := networkSigned(s, *req.Network, req.NetworkSignature); err != nil {
		v.Log.Warn("network facts dropped", "machine", s.machine.Name, "err", err)
		return nil
	}
	n := cleanNetwork(*req.Network)
	if from := clientOf(ctx); n.Address != "" && n.Address != from {
		why := fmt.Sprintf("fleetd: the attested address %s is not the address the evidence came from (%s); the address is not recorded", n.Address, orUnknown(from))
		v.Log.Warn("attested address dropped", "machine", s.machine.Name, "address", n.Address, "from", from)
		if v.NetBox != nil && s.machine.NetBoxID != 0 {
			v.NetBox.journalLater(ctx, s.machine.NetBoxID, "warning", why, s.machine.Serial)
		}
		n.Address = ""
	}
	if n.Address == "" && n.LLDP == nil {
		return nil
	}
	return &n
}

func orUnknown(s string) string {
	if s == "" {
		return "unknown"
	}
	return s
}

// networkSigned checks that the session's AK signed NetworkDigest of the
// facts with ECDSA over SHA-256, as AKTemplate prescribes.
func networkSigned(s *session, n protocol.Network, raw []byte) error {
	if len(raw) == 0 {
		return errors.New("the network facts are not signed")
	}
	sig, err := tpm2.DecodeSignature(bytes.NewBuffer(raw))
	if err != nil || sig.Alg != tpm2.AlgECDSA || sig.ECC == nil || sig.ECC.HashAlg != tpm2.AlgSHA256 {
		return errors.New("the network facts' signature is not ECDSA over SHA-256")
	}
	pub, ok := s.ak.Public.(*ecdsa.PublicKey)
	if !ok || !ecdsa.Verify(pub, protocol.NetworkDigest(s.nonce, n), sig.ECC.R, sig.ECC.S) {
		return errors.New("the network facts are not signed by the session's AK")
	}
	return nil
}

// cleanNetwork keeps an IPv4 address and an LLDP neighbour with a chassis
// ID and a port ID of printable ASCII, each at most 255 characters.
func cleanNetwork(n protocol.Network) protocol.Network {
	var out protocol.Network
	if a, err := netip.ParseAddr(n.Address); err == nil && a.Is4() {
		out.Address = a.String()
	}
	if l := n.LLDP; l != nil && l.ChassisID != "" && l.PortID != "" && printable(l.ChassisID, l.PortID, l.PortDescription, l.SystemName) {
		c := *l
		out.LLDP = &c
	}
	return out
}

func printable(ss ...string) bool {
	for _, s := range ss {
		if len(s) > 255 {
			return false
		}
		for i := 0; i < len(s); i++ {
			if s[i] < 0x20 || s[i] > 0x7e {
				return false
			}
		}
	}
	return true
}
