package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// EnsureMAC puts the MAC on the device's first physical interface as its
// primary MAC, making an interface eth0 when the device has none, and says
// which interface. A device born of a stub may have no interface, or only
// the MAC-less one its device type's template made.
func (n *NetBox) EnsureMAC(ctx context.Context, deviceID int, mac string) (int, error) {
	var raws []json.RawMessage
	if err := n.list(ctx, fmt.Sprintf("/api/dcim/interfaces/?device_id=%d&type__n=virtual", deviceID), &raws); err != nil {
		return 0, err
	}
	nic := 0
	for _, raw := range raws {
		var i rawInterface
		if err := json.Unmarshal(raw, &i); err != nil {
			return 0, err
		}
		if i.PrimaryMAC != nil && i.PrimaryMAC.MAC != "" {
			if strings.EqualFold(i.PrimaryMAC.MAC, mac) {
				return i.ID, nil
			}
			continue
		}
		if nic == 0 || i.ID < nic {
			nic = i.ID
		}
	}
	if nic == 0 {
		var created struct {
			ID int `json:"id"`
		}
		if err := n.do(ctx, http.MethodPost, "/api/dcim/interfaces/", map[string]any{"device": deviceID, "name": "eth0", "type": "1000base-t"}, &created); err != nil {
			return 0, err
		}
		nic = created.ID
	}
	var m struct {
		ID int `json:"id"`
	}
	if err := n.do(ctx, http.MethodPost, "/api/dcim/mac-addresses/", map[string]any{
		"mac_address":          strings.ToUpper(mac),
		"assigned_object_type": "dcim.interface",
		"assigned_object_id":   nic,
	}, &m); err != nil {
		return 0, err
	}
	return nic, n.do(ctx, http.MethodPatch, fmt.Sprintf("/api/dcim/interfaces/%d/", nic), map[string]any{"primary_mac_address": m.ID}, nil)
}

// fillPort cables a staged or active node whose interface has no cable to
// the rack port UniFi sees it on, once it has left the intake port, and
// journals the move.
func (r *Reconciler) fillPort(ctx context.Context, d Device, p *bindPass) error {
	if r.UniFi == nil || d.MAC == "" || d.NIC == 0 || d.Cabled || (d.Status != "staged" && d.Status != "active") {
		return nil
	}
	sw, port, _ := r.where(ctx, p, d.MAC)
	if sw == nil || port == r.Config.IntakePort {
		return nil
	}
	var b binding
	if err := r.cable(ctx, d, sw, port, &b); err != nil {
		return err
	}
	if len(b.notes) == 0 {
		return nil
	}
	Audit("fleet.bind", r.Config.Site, d, d.LastWorkflow, "port: "+strings.Join(b.notes, "; "))
	return r.NetBox.Update(ctx, d, "", nil, "info", "fleet-controller: UniFi sees the node on a rack port; "+strings.Join(b.notes, "; "))
}
