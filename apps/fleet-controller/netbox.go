package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// NetBox is the system of record: the devices of one site with the role
// kubernetes-node, their lifecycle status and the custom fields of the fleet
// contract (.agent/plans/fleet/spec.md).
type NetBox struct {
	URL    string
	Token  string
	Client *http.Client
}

// Device is what the controller reads from one NetBox device.
type Device struct {
	ID            int
	Name          string
	Serial        string
	Status        string
	Address       string
	MAC           string
	Disk          string
	Class         string
	TPM           string
	BMCType       string
	BMCAddress    string
	OOBAddress    string
	DesiredAction string
	LastWorkflow  string
	// SMBIOSUUID is the machine's attested SMBIOS UUID, which talos-attest
	// writes on a pass.
	SMBIOSUUID string
}

// Role is the NetBox device role of a node. Every status here is a device the
// controller keeps Tinkerbell objects for; offline and inventory devices get
// none.
const Role = "kubernetes-node"

var liveStatuses = []string{"planned", "staged", "active", "failed", "decommissioning"}

func (n *NetBox) do(ctx context.Context, method, path string, body, out any) error {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimSuffix(n.URL, "/")+path, rd)
	if err != nil {
		return err
	}
	// NetBox 4.5's v2 tokens start nbt_ and go as Bearer; older tokens as Token.
	scheme := "Token"
	if strings.HasPrefix(n.Token, "nbt_") {
		scheme = "Bearer"
	}
	req.Header.Set("Authorization", scheme+" "+n.Token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := n.Client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("%s %s: %s: %s", method, path, resp.Status, strings.TrimSpace(string(msg)))
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}

// list follows a list endpoint's next links. The link names whatever host the
// request claimed to be, so only its path and query are used.
func (n *NetBox) list(ctx context.Context, path string, out *[]json.RawMessage) error {
	sep := "?"
	if strings.Contains(path, "?") {
		sep = "&"
	}
	next := path + sep + "limit=100"
	for i := 0; next != ""; i++ {
		if i > 1000 {
			return fmt.Errorf("%s: more than 1000 pages", path)
		}
		var page struct {
			Next    *string           `json:"next"`
			Results []json.RawMessage `json:"results"`
		}
		if err := n.do(ctx, http.MethodGet, next, nil, &page); err != nil {
			return err
		}
		*out = append(*out, page.Results...)
		next = ""
		if page.Next != nil && *page.Next != "" {
			u, err := url.Parse(*page.Next)
			if err != nil {
				return fmt.Errorf("next link %q: %w", *page.Next, err)
			}
			next = u.RequestURI()
		}
	}
	return nil
}

// selectValue reads a NetBox value that is a plain string in one API shape and
// a {value, label} object in another: status fields, and select custom fields
// in a webhook payload.
func selectValue(raw json.RawMessage) string {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	var o struct {
		Value string `json:"value"`
	}
	if err := json.Unmarshal(raw, &o); err == nil {
		return o.Value
	}
	return ""
}

type rawDevice struct {
	ID         int             `json:"id"`
	Name       string          `json:"name"`
	Serial     string          `json:"serial"`
	Status     json.RawMessage `json:"status"`
	PrimaryIP4 *struct {
		Address string `json:"address"`
	} `json:"primary_ip4"`
	OOBIP *struct {
		Address string `json:"address"`
	} `json:"oob_ip"`
	CustomFields map[string]json.RawMessage `json:"custom_fields"`
}

func stripPrefix(cidr string) string {
	addr, _, _ := strings.Cut(cidr, "/")
	return addr
}

func parseDevice(raw json.RawMessage) (Device, error) {
	var r rawDevice
	if err := json.Unmarshal(raw, &r); err != nil {
		return Device{}, err
	}
	cf := func(k string) string { return selectValue(r.CustomFields[k]) }
	d := Device{
		ID:            r.ID,
		Name:          r.Name,
		Serial:        r.Serial,
		Status:        selectValue(r.Status),
		Disk:          cf("install_disk"),
		Class:         cf("talos_class"),
		TPM:           cf("tpm_version"),
		BMCType:       cf("bmc_type"),
		DesiredAction: cf("desired_action"),
		LastWorkflow:  cf("last_workflow"),
		SMBIOSUUID:    strings.ToLower(cf("smbios_uuid")),
	}
	if d.BMCType == "" {
		d.BMCType = "none"
	}
	if d.DesiredAction == "" {
		d.DesiredAction = "none"
	}
	if r.PrimaryIP4 != nil {
		d.Address = stripPrefix(r.PrimaryIP4.Address)
	}
	if r.OOBIP != nil {
		d.OOBAddress = stripPrefix(r.OOBIP.Address)
	}
	// The export's rule: oob_ip, or the node's address for AMT, which shares the node's NIC.
	switch {
	case d.BMCType == "none":
	case r.OOBIP != nil && r.OOBIP.Address != "":
		d.BMCAddress = stripPrefix(r.OOBIP.Address)
	case d.BMCType == "amt":
		d.BMCAddress = d.Address
	}
	return d, nil
}

// Devices lists the site's live nodes with the MAC of each one's first
// physical interface that has a primary MAC.
func (n *NetBox) Devices(ctx context.Context, site string) ([]Device, error) {
	q := url.Values{}
	q.Set("site", site)
	q.Set("role", Role)
	for _, s := range liveStatuses {
		q.Add("status", s)
	}
	var raws []json.RawMessage
	if err := n.list(ctx, "/api/dcim/devices/?"+q.Encode(), &raws); err != nil {
		return nil, err
	}
	devices := make([]Device, 0, len(raws))
	byID := map[int]int{}
	for _, raw := range raws {
		d, err := parseDevice(raw)
		if err != nil {
			return nil, err
		}
		byID[d.ID] = len(devices)
		devices = append(devices, d)
	}
	if len(devices) == 0 {
		return devices, nil
	}
	iq := url.Values{}
	iq.Set("type__n", "virtual")
	for _, d := range devices {
		iq.Add("device_id", fmt.Sprint(d.ID))
	}
	var iraws []json.RawMessage
	if err := n.list(ctx, "/api/dcim/interfaces/?"+iq.Encode(), &iraws); err != nil {
		return nil, err
	}
	type iface struct {
		ID     int `json:"id"`
		Device struct {
			ID int `json:"id"`
		} `json:"device"`
		PrimaryMAC *struct {
			MAC string `json:"mac_address"`
		} `json:"primary_mac_address"`
	}
	var ifaces []iface
	for _, raw := range iraws {
		var i iface
		if err := json.Unmarshal(raw, &i); err != nil {
			return nil, err
		}
		if i.PrimaryMAC != nil && i.PrimaryMAC.MAC != "" {
			ifaces = append(ifaces, i)
		}
	}
	sort.Slice(ifaces, func(a, b int) bool { return ifaces[a].ID < ifaces[b].ID })
	for _, i := range ifaces {
		idx, ok := byID[i.Device.ID]
		if ok && devices[idx].MAC == "" {
			devices[idx].MAC = strings.ToLower(i.PrimaryMAC.MAC)
		}
	}
	sort.Slice(devices, func(a, b int) bool { return devices[a].Name < devices[b].Name })
	return devices, nil
}

// Find lists the site's nodes, in any status, whose filter field matches the
// value: serial, or a custom field as cf_<name>. NetBox may match loosely, so
// the callers compare the field themselves.
func (n *NetBox) Find(ctx context.Context, site, filter, value string) ([]Device, error) {
	q := url.Values{}
	q.Set("site", site)
	q.Set("role", Role)
	q.Set(filter, value)
	var raws []json.RawMessage
	if err := n.list(ctx, "/api/dcim/devices/?"+q.Encode(), &raws); err != nil {
		return nil, err
	}
	devices := make([]Device, 0, len(raws))
	for _, raw := range raws {
		d, err := parseDevice(raw)
		if err != nil {
			return nil, err
		}
		devices = append(devices, d)
	}
	return devices, nil
}

// ErrNoDevice is a lookup that found no node.
var ErrNoDevice = errors.New("NetBox has no such node")

// BySerial is the site's node with this serial.
func (n *NetBox) BySerial(ctx context.Context, site, serial string) (Device, error) {
	devices, err := n.Find(ctx, site, "serial", serial)
	if err != nil {
		return Device{}, err
	}
	for _, d := range devices {
		if strings.EqualFold(d.Serial, serial) {
			return d, nil
		}
	}
	return Device{}, ErrNoDevice
}

// BySMBIOSUUID is the site's node whose smbios_uuid is this UUID.
func (n *NetBox) BySMBIOSUUID(ctx context.Context, site, uuid string) (Device, error) {
	devices, err := n.Find(ctx, site, "cf_smbios_uuid", uuid)
	if err != nil {
		return Device{}, err
	}
	for _, d := range devices {
		if d.SMBIOSUUID == strings.ToLower(uuid) {
			return d, nil
		}
	}
	return Device{}, ErrNoDevice
}

// Update patches a device's status and custom fields, and adds a journal
// entry when comment is set.
func (n *NetBox) Update(ctx context.Context, d Device, status string, fields map[string]any, kind, comment string) error {
	patch := map[string]any{}
	if status != "" {
		patch["status"] = status
	}
	if len(fields) > 0 {
		patch["custom_fields"] = fields
	}
	if len(patch) > 0 {
		if err := n.do(ctx, http.MethodPatch, fmt.Sprintf("/api/dcim/devices/%d/", d.ID), patch, nil); err != nil {
			return err
		}
	}
	if comment == "" {
		return nil
	}
	return n.do(ctx, http.MethodPost, "/api/extras/journal-entries/", map[string]any{
		"assigned_object_type": "dcim.device",
		"assigned_object_id":   d.ID,
		"kind":                 kind,
		"comments":             comment,
	}, nil)
}

func timestamp(t time.Time) string { return t.UTC().Format(time.RFC3339) }
