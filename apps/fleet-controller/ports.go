package main

import (
	"context"
	"fmt"
	"strings"
)

// fillPort follows a staged or active node to its rack port once it has left
// the intake port. A node whose interface has no cable is cabled to the port
// UniFi sees it on, and the move is journaled. A node on another port than
// its expected_port is journaled once: the port check binds a machine, and
// a move after it is the owner's to judge.
func (r *Reconciler) fillPort(ctx context.Context, d Device, p *bindPass) error {
	if r.UniFi == nil || d.MAC == "" || d.NIC == 0 || (d.Status != "staged" && d.Status != "active") {
		return nil
	}
	if d.Cabled && d.ExpectedPort == 0 {
		return nil
	}
	sw, port, _ := r.where(ctx, p, d.MAC)
	if sw == nil || port == r.Config.IntakePort {
		return nil
	}
	if d.ExpectedPort != 0 && port != d.ExpectedPort {
		why := "fleet-controller: UniFi sees the node " + portMismatch(port, d.ExpectedPort, "its expected_port")
		if err := r.journalOnce(ctx, fmt.Sprintf("port-moved/%d/%d", d.ID, port), d, "warning", why); err != nil {
			return err
		}
	}
	if d.Cabled {
		return nil
	}
	var b binding
	if err := r.cable(ctx, d, sw, port, true, &b); err != nil {
		return err
	}
	if len(b.notes) == 0 {
		return nil
	}
	Audit("fleet.bind", r.Config.Site, d, d.LastWorkflow, "port: "+strings.Join(b.notes, "; "))
	return r.NetBox.Update(ctx, d, "", nil, "info", "fleet-controller: UniFi sees the node on a rack port; "+strings.Join(b.notes, "; "))
}
