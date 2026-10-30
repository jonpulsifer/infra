package main

import (
	"context"
	"fmt"
	"strings"
)

// fillPort follows an installing or active node to its rack port once it has left
// the intake port. Each intake pass attests the port, and one younger than
// AttestedPortTTL off the intake port cables a node whose interface has no
// cable, unless another device's cable holds the port; the move is
// journaled. A node on another port than its expected_port is journaled
// once: the port check binds a machine, and a move after it is the owner's
// to judge.
func (r *Reconciler) fillPort(ctx context.Context, d Device, p *bindPass) error {
	now := r.Now()
	if d.MAC == "" || d.NIC == 0 || (!d.Installing() && d.Status != "active") || !fresh(d.Attested.At, now, AttestedPortTTL) {
		return nil
	}
	if d.Cabled && d.ExpectedPort == 0 {
		return nil
	}
	sw, port, _ := r.where(ctx, p, d, now.Add(-AttestedPortTTL))
	if sw == nil || port == r.Config.IntakePort {
		return nil
	}
	if d.ExpectedPort != 0 && port != d.ExpectedPort {
		why := "fleet-controller: its intake pass attested the node " + portMismatch(port, d.ExpectedPort, "its expected_port")
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
	return r.NetBox.Update(ctx, d, "", nil, "info", "fleet-controller: its intake pass attested a rack port; "+strings.Join(b.notes, "; "))
}
