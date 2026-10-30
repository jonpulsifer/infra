package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// The NetBox calls of an intake and its binding: the MAC lookup, the device
// patch and delete, addresses in the node prefix, the switch and its cables.

// HasMAC says whether a NetBox interface holds the MAC.
func (n *NetBox) HasMAC(ctx context.Context, mac string) (bool, error) {
	var raws []json.RawMessage
	if err := n.list(ctx, "/api/dcim/mac-addresses/?mac_address="+url.QueryEscape(strings.ToUpper(mac)), &raws); err != nil {
		return false, err
	}
	for _, raw := range raws {
		var m struct {
			MAC      string          `json:"mac_address"`
			Assigned json.RawMessage `json:"assigned_object"`
		}
		if err := json.Unmarshal(raw, &m); err != nil {
			return false, err
		}
		if strings.EqualFold(m.MAC, mac) && len(m.Assigned) > 0 && string(m.Assigned) != "null" {
			return true, nil
		}
	}
	return false, nil
}

// Patch changes a device's own fields: name, description, primary_ip4 and
// custom_fields.
func (n *NetBox) Patch(ctx context.Context, id int, patch map[string]any) error {
	return n.do(ctx, http.MethodPatch, fmt.Sprintf("/api/dcim/devices/%d/", id), patch, nil)
}

// DeleteDevice deletes a device; a missing one is no error.
func (n *NetBox) DeleteDevice(ctx context.Context, id int) error {
	err := n.do(ctx, http.MethodDelete, fmt.Sprintf("/api/dcim/devices/%d/", id), nil, nil)
	if err != nil && strings.Contains(err.Error(), "404") {
		return nil
	}
	return err
}

// IP is one NetBox IP address.
type IP struct {
	ID           int    `json:"id"`
	Address      string `json:"address"`
	DNSName      string `json:"dns_name"`
	AssignedType string `json:"assigned_object_type"`
	AssignedID   *int   `json:"assigned_object_id"`
}

// Unassigned says whether the address belongs to no interface.
func (ip IP) Unassigned() bool { return ip.AssignedID == nil }

// On says whether the address is on the interface.
func (ip IP) On(nic int) bool {
	return ip.AssignedType == "dcim.interface" && ip.AssignedID != nil && *ip.AssignedID == nic
}

// IPsNamed lists the addresses whose DNS name is the name.
func (n *NetBox) IPsNamed(ctx context.Context, name string) ([]IP, error) {
	var raws []json.RawMessage
	if err := n.list(ctx, "/api/ipam/ip-addresses/?dns_name="+url.QueryEscape(name), &raws); err != nil {
		return nil, err
	}
	var ips []IP
	for _, raw := range raws {
		var ip IP
		if err := json.Unmarshal(raw, &ip); err != nil {
			return nil, err
		}
		if strings.EqualFold(ip.DNSName, name) {
			ips = append(ips, ip)
		}
	}
	return ips, nil
}

// AvailableIPs lists the free addresses of the prefix, as address/length,
// lowest first.
func (n *NetBox) AvailableIPs(ctx context.Context, prefix string) ([]string, error) {
	var raws []json.RawMessage
	if err := n.list(ctx, "/api/ipam/prefixes/?prefix="+url.QueryEscape(prefix), &raws); err != nil {
		return nil, err
	}
	id := 0
	for _, raw := range raws {
		var p struct {
			ID     int    `json:"id"`
			Prefix string `json:"prefix"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, err
		}
		if p.Prefix == prefix {
			id = p.ID
			break
		}
	}
	if id == 0 {
		return nil, fmt.Errorf("NetBox has no prefix %s", prefix)
	}
	var free []struct {
		Address string `json:"address"`
	}
	if err := n.do(ctx, http.MethodGet, fmt.Sprintf("/api/ipam/prefixes/%d/available-ips/?limit=1000", id), nil, &free); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(free))
	for _, f := range free {
		out = append(out, f.Address)
	}
	return out, nil
}

// AssignIP puts an address on an interface, creating it when id is 0, and
// names it.
func (n *NetBox) AssignIP(ctx context.Context, id int, address string, nic int, dnsName string) (int, error) {
	body := map[string]any{
		"assigned_object_type": "dcim.interface",
		"assigned_object_id":   nic,
		"status":               "active",
		"dns_name":             dnsName,
	}
	var out struct {
		ID int `json:"id"`
	}
	if id != 0 {
		return id, n.do(ctx, http.MethodPatch, fmt.Sprintf("/api/ipam/ip-addresses/%d/", id), body, &out)
	}
	body["address"] = address
	body["description"] = "Allocated by fleet-controller on intake"
	if err := n.do(ctx, http.MethodPost, "/api/ipam/ip-addresses/", body, &out); err != nil {
		return 0, err
	}
	return out.ID, nil
}

// Switch is a NetBox device with the role switch and the MACs of its
// interfaces, one of which is the chassis ID its LLDP frames carry.
type Switch struct {
	ID   int
	Name string
	MACs map[string]bool
}

type rawInterface struct {
	ID     int `json:"id"`
	Device struct {
		ID   int    `json:"id"`
		Name string `json:"name"`
	} `json:"device"`
	Name       string `json:"name"`
	PrimaryMAC *struct {
		MAC string `json:"mac_address"`
	} `json:"primary_mac_address"`
	Cable *struct {
		ID int `json:"id"`
	} `json:"cable"`
	LinkPeers []struct {
		ID     int    `json:"id"`
		Name   string `json:"name"`
		Device struct {
			Name string `json:"name"`
		} `json:"device"`
	} `json:"link_peers"`
}

// Switches lists the site's switches.
func (n *NetBox) Switches(ctx context.Context, site string) ([]Switch, error) {
	var raws []json.RawMessage
	if err := n.list(ctx, "/api/dcim/devices/?site="+url.QueryEscape(site)+"&role=switch", &raws); err != nil {
		return nil, err
	}
	switches := make([]Switch, 0, len(raws))
	q := url.Values{}
	for _, raw := range raws {
		var d struct {
			ID   int    `json:"id"`
			Name string `json:"name"`
		}
		if err := json.Unmarshal(raw, &d); err != nil {
			return nil, err
		}
		switches = append(switches, Switch{ID: d.ID, Name: d.Name, MACs: map[string]bool{}})
		q.Add("device_id", fmt.Sprint(d.ID))
	}
	if len(switches) == 0 {
		return switches, nil
	}
	var iraws []json.RawMessage
	if err := n.list(ctx, "/api/dcim/interfaces/?"+q.Encode(), &iraws); err != nil {
		return nil, err
	}
	for _, raw := range iraws {
		var i rawInterface
		if err := json.Unmarshal(raw, &i); err != nil {
			return nil, err
		}
		if i.PrimaryMAC == nil {
			continue
		}
		for k := range switches {
			if switches[k].ID == i.Device.ID {
				switches[k].MACs[strings.ToLower(i.PrimaryMAC.MAC)] = true
			}
		}
	}
	return switches, nil
}

func (n *NetBox) iface(ctx context.Context, id int) (rawInterface, error) {
	var i rawInterface
	err := n.do(ctx, http.MethodGet, fmt.Sprintf("/api/dcim/interfaces/%d/", id), nil, &i)
	return i, err
}

// SwitchPort is the id of the switch's interface Port <port>, or 0.
func (n *NetBox) SwitchPort(ctx context.Context, switchID, port int) (int, error) {
	var raws []json.RawMessage
	if err := n.list(ctx, fmt.Sprintf("/api/dcim/interfaces/?device_id=%d&name=%s", switchID, url.QueryEscape(fmt.Sprintf("Port %d", port))), &raws); err != nil {
		return 0, err
	}
	for _, raw := range raws {
		var i rawInterface
		if err := json.Unmarshal(raw, &i); err != nil {
			return 0, err
		}
		if i.Name == fmt.Sprintf("Port %d", port) {
			return i.ID, nil
		}
	}
	return 0, nil
}

// ErrPortTaken is a cable a declaration asked for to a switch port that
// another cable holds.
var ErrPortTaken = errors.New("the switch port has another cable")

// Cable makes one cable between the two interfaces, replacing any cable
// either has to somewhere else, when steal says that what LLDP reports beats
// what NetBox holds; without it, a taken switch port is ErrPortTaken. It
// says whether it made one, and which links it replaced.
func (n *NetBox) Cable(ctx context.Context, a, b int, steal bool) (bool, []string, error) {
	ai, err := n.iface(ctx, a)
	if err != nil {
		return false, nil, err
	}
	if ai.Cable != nil {
		for _, p := range ai.LinkPeers {
			if p.ID == b {
				return false, nil, nil
			}
		}
	}
	bi, err := n.iface(ctx, b)
	if err != nil {
		return false, nil, err
	}
	if bi.Cable != nil && !steal {
		return false, nil, ErrPortTaken
	}
	var replaced []string
	seen := map[int]bool{}
	for _, end := range []rawInterface{ai, bi} {
		if end.Cable == nil || seen[end.Cable.ID] {
			continue
		}
		seen[end.Cable.ID] = true
		for _, p := range end.LinkPeers {
			replaced = append(replaced, fmt.Sprintf("%s %s to %s %s", end.Device.Name, end.Name, p.Device.Name, p.Name))
		}
		if err := n.do(ctx, http.MethodDelete, fmt.Sprintf("/api/dcim/cables/%d/", end.Cable.ID), nil, nil); err != nil {
			return false, nil, err
		}
	}
	err = n.do(ctx, http.MethodPost, "/api/dcim/cables/", map[string]any{
		"a_terminations": []any{map[string]any{"object_type": "dcim.interface", "object_id": a}},
		"b_terminations": []any{map[string]any{"object_type": "dcim.interface", "object_id": b}},
		"status":         "connected",
	}, nil)
	return err == nil, replaced, err
}
