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

// checkPort journals once an installing or active node whose intake pass,
// younger than AttestedPortTTL, attested a switch port other than its
// expected_port: the port check admits a machine, and a move after it is the
// owner's to judge. It never cables the node; Terraform owns the cable.
func (r *Reconciler) checkPort(ctx context.Context, d Device) error {
	now := r.Now()
	if d.ExpectedPort == 0 || (!d.Installing() && d.Status != "active") || !fresh(d.Attested.At, now, AttestedPortTTL) {
		return nil
	}
	port, _ := r.where(ctx, d, now.Add(-AttestedPortTTL))
	if port == 0 || port == d.ExpectedPort {
		return nil
	}
	why := "fleetd: its intake pass attested the node " + portMismatch(port, d.ExpectedPort, "its expected_port")
	return r.journalOnce(ctx, fmt.Sprintf("port-moved/%d/%d", d.ID, port), d, "warning", why)
}
