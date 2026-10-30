package fleet

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

var portName = regexp.MustCompile(`^(?i:port) ?([1-9][0-9]{0,3})$`)

// portNumber is the switch port an LLDP port ID names as "Port <n>".
func portNumber(portID string) (int, bool) {
	m := portName.FindStringSubmatch(strings.TrimSpace(portID))
	if m == nil {
		return 0, false
	}
	n, _ := strconv.Atoi(m[1])
	return n, true
}

// plain strips what NetBox's journal would render as Markdown, and control
// characters, from text a machine or a switch supplied, as the verifier's
// plain does.
func plain(s string) string {
	return strings.TrimSpace(strings.Map(func(r rune) rune {
		if r < ' ' || r == 0x7f || strings.ContainsRune("*_`#[]()<>|~\\", r) {
			return ' '
		}
		return r
	}, s))
}

// fillPort cables an installing or active node whose interface has no cable
// to the switch port its intake pass attested, when that pass is younger than
// AttestedPortTTL, unless another device's cable holds the port; the cable is
// journaled. A node on another port than its expected_port is journaled
// once: the port check admits a machine, and a move after it is the owner's
// to judge.
func (r *Reconciler) fillPort(ctx context.Context, d Device, p *passCache) error {
	now := r.Now()
	if d.MAC == "" || d.NIC == 0 || (!d.Installing() && d.Status != "active") || !fresh(d.Attested.At, now, AttestedPortTTL) {
		return nil
	}
	if d.Cabled && d.ExpectedPort == 0 {
		return nil
	}
	sw, port, _ := r.where(ctx, p, d, now.Add(-AttestedPortTTL))
	if sw == nil {
		return nil
	}
	if d.ExpectedPort != 0 && port != d.ExpectedPort {
		why := "fleetd: its intake pass attested the node " + portMismatch(port, d.ExpectedPort, "its expected_port")
		if err := r.journalOnce(ctx, fmt.Sprintf("port-moved/%d/%d", d.ID, port), d, "warning", why); err != nil {
			return err
		}
	}
	if d.Cabled {
		return nil
	}
	var b binding
	made, err := r.cable(ctx, d, sw, port, &b)
	if err != nil || !made {
		return err
	}
	Audit("fleet.bind", r.Config.Site, d, d.LastWorkflow, "port: "+strings.Join(b.notes, "; "))
	return r.NetBox.Update(ctx, d, "", nil, "info", "fleetd: its intake pass attested a switch port; "+strings.Join(b.notes, "; "))
}
