package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

// Node is one machine as the directory knows it: the facts a render needs and,
// from NetBox, the lifecycle that decides an approval without a click.
type Node struct {
	Name    string `json:"name"`
	Serial  string `json:"serial"`
	MAC     string `json:"mac"`
	Class   string `json:"class"`
	Address string `json:"address"`
	Disk    string `json:"disk"`
	// TPM is the TPM's spec version, "2.0" for a node that seals its disks.
	TPM string `json:"tpm"`
	// Status is the NetBox status: planned, staged, active, failed, and so on.
	Status string `json:"status"`
	// Verdict is NetBox's attest_verdict, LastAttested its last_attested, and
	// ConsumedAt its attest_consumed_at. Only NetBox fills them.
	Verdict      string    `json:"attest_verdict,omitempty"`
	LastAttested time.Time `json:"last_attested,omitempty"`
	ConsumedAt   time.Time `json:"attest_consumed_at,omitempty"`
	// ConsumedUnknown is an attest_consumed_at that did not parse. It counts
	// as spent.
	ConsumedUnknown bool `json:"-"`
	// Source names where the node came from: netbox or inventory.
	Source string `json:"source"`
	// ID is the NetBox device id, 0 from the inventory.
	ID int `json:"-"`
}

// Attested says whether the node's newest attestation is unspent: the device
// is staged, its verdict is a pass, and no config was released on that pass.
func (n Node) Attested() (bool, string) {
	switch {
	case n.Source != "netbox":
		return false, "the inventory holds no attestation"
	case n.Status != "staged":
		return false, fmt.Sprintf("NetBox has it %s, not staged", n.Status)
	case n.Verdict != "attested":
		if n.Verdict == "" {
			return false, "NetBox records no attestation"
		}
		return false, "NetBox records its attestation as " + n.Verdict
	case n.LastAttested.IsZero():
		return false, "NetBox records no attestation time"
	case n.ConsumedUnknown:
		return false, "NetBox's attest_consumed_at is unreadable, which counts as spent"
	case !n.ConsumedAt.IsZero() && !n.ConsumedAt.Before(n.LastAttested):
		return false, "its latest attestation already released a config"
	}
	return true, ""
}

// Directory finds nodes by serial and by name, and records what the server
// decides about them.
type Directory interface {
	BySerial(ctx context.Context, serial string) (Node, error)
	// ByName refuses a retired device with ErrRetired.
	ByName(ctx context.Context, name string) (Node, error)
	Names(ctx context.Context) ([]string, error)
	// Spend records at as the device's attest_consumed_at before a token is
	// issued on the strength of its attestation. A failure refuses the
	// approval.
	Spend(ctx context.Context, n Node, at time.Time) error
	// Released records that the node's config left the server at the time
	// given: the device becomes active if it was planned or staged, and any
	// attestation before that time is spent.
	Released(ctx context.Context, n Node, at time.Time) error
}

// ErrUnknownNode is a name or serial the directory does not hold.
var ErrUnknownNode = errors.New("unknown node")

// ErrRetired is a device whose status is decommissioning or offline.
var ErrRetired = errors.New("the device is retired")

func retired(status string) bool { return status == "decommissioning" || status == "offline" }

func serialKey(s string) string { return strings.ToUpper(strings.TrimSpace(s)) }

// Inventory is clusters/<site>/inventory/machines.yaml, NetBox's export: the
// directory when NetBox is not configured or does not answer. It carries no
// attestation, so a node from it always waits for a click, and it records
// nothing.
type Inventory struct {
	byName map[string]Node
}

// LoadInventory reads machines.yaml. A missing path is an empty inventory.
func LoadInventory(path string) (*Inventory, error) {
	inv := &Inventory{byName: map[string]Node{}}
	if path == "" {
		return inv, nil
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var doc struct {
		Machines map[string]struct {
			Serial  string `yaml:"serial"`
			MAC     string `yaml:"mac"`
			Class   string `yaml:"class"`
			Status  string `yaml:"status"`
			Address string `yaml:"address"`
			Disk    string `yaml:"disk"`
			TPM     string `yaml:"tpm"`
		} `yaml:"machines"`
	}
	if err := yaml.Unmarshal(b, &doc); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	for name, m := range doc.Machines {
		inv.byName[name] = Node{
			Name: name, Serial: m.Serial, MAC: strings.ToLower(m.MAC), Class: m.Class,
			Address: m.Address, Disk: m.Disk, TPM: m.TPM, Status: m.Status, Source: "inventory",
		}
	}
	return inv, nil
}

func (inv *Inventory) BySerial(_ context.Context, serial string) (Node, error) {
	for _, n := range inv.byName {
		if n.Serial != "" && serialKey(n.Serial) == serialKey(serial) {
			return n, nil
		}
	}
	return Node{}, ErrUnknownNode
}

func (inv *Inventory) ByName(_ context.Context, name string) (Node, error) {
	n, ok := inv.byName[name]
	if !ok {
		return Node{}, ErrUnknownNode
	}
	if retired(n.Status) {
		return Node{}, fmt.Errorf("%w: %s is %s", ErrRetired, name, n.Status)
	}
	return n, nil
}

func (inv *Inventory) Names(context.Context) ([]string, error) {
	names := make([]string, 0, len(inv.byName))
	for name, n := range inv.byName {
		if n.Class != "" && !retired(n.Status) {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names, nil
}

// Spend cannot record anything, so nothing is spent and the approval must not
// proceed on the inventory's word.
func (inv *Inventory) Spend(context.Context, Node, time.Time) error {
	return errors.New("the inventory file records no spend")
}

// Released does nothing: the export is read-only.
func (inv *Inventory) Released(context.Context, Node, time.Time) error { return nil }

// NetBox reads kubernetes-node devices of one site and writes the lifecycle.
type NetBox struct {
	URL    string
	Token  string
	Site   string
	Client *http.Client
	Log    *slog.Logger
}

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
		return json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(out)
	}
	return nil
}

type netboxDevice struct {
	ID     int    `json:"id"`
	Name   string `json:"name"`
	Serial string `json:"serial"`
	Status struct {
		Value string `json:"value"`
	} `json:"status"`
	PrimaryIP4 *struct {
		Address string `json:"address"`
	} `json:"primary_ip4"`
	CustomFields struct {
		Class        string `json:"talos_class"`
		Disk         string `json:"install_disk"`
		TPM          string `json:"tpm_version"`
		Verdict      string `json:"attest_verdict"`
		LastAttested string `json:"last_attested"`
		ConsumedAt   string `json:"attest_consumed_at"`
	} `json:"custom_fields"`
}

type netboxInterface struct {
	ID         int `json:"id"`
	PrimaryMAC *struct {
		MAC string `json:"mac_address"`
	} `json:"primary_mac_address"`
}

func (n *NetBox) query(ctx context.Context, filter string) ([]netboxDevice, error) {
	var page struct {
		Results []netboxDevice `json:"results"`
	}
	path := "/api/dcim/devices/?limit=100&role=kubernetes-node&site=" + url.QueryEscape(n.Site) + filter
	if err := n.do(ctx, http.MethodGet, path, nil, &page); err != nil {
		return nil, err
	}
	return page.Results, nil
}

func (n *NetBox) node(ctx context.Context, d netboxDevice) (Node, error) {
	var page struct {
		Results []netboxInterface `json:"results"`
	}
	if err := n.do(ctx, http.MethodGet, fmt.Sprintf("/api/dcim/interfaces/?device_id=%d&limit=50", d.ID), nil, &page); err != nil {
		return Node{}, err
	}
	sort.Slice(page.Results, func(i, j int) bool { return page.Results[i].ID < page.Results[j].ID })
	out := Node{
		Name: d.Name, Serial: d.Serial, Class: d.CustomFields.Class, Disk: d.CustomFields.Disk,
		TPM: d.CustomFields.TPM, Status: d.Status.Value, Verdict: d.CustomFields.Verdict,
		Source: "netbox", ID: d.ID,
	}
	for _, i := range page.Results {
		if i.PrimaryMAC != nil && i.PrimaryMAC.MAC != "" {
			out.MAC = strings.ToLower(i.PrimaryMAC.MAC)
			break
		}
	}
	if d.PrimaryIP4 != nil {
		out.Address, _, _ = strings.Cut(d.PrimaryIP4.Address, "/")
	}
	// An unreadable last_attested is no attestation; an unreadable
	// attest_consumed_at is a spent one. Both fail closed.
	out.LastAttested, _ = parseNetBoxTime(d.CustomFields.LastAttested)
	var ok bool
	out.ConsumedAt, ok = parseNetBoxTime(d.CustomFields.ConsumedAt)
	out.ConsumedUnknown = !ok
	return out, nil
}

// parseNetBoxTime reads a datetime custom field, which NetBox returns in
// RFC 3339. An empty value is the zero time and reads fine; a value that does
// not parse reads as the zero time and false.
func parseNetBoxTime(s string) (time.Time, bool) {
	if s == "" {
		return time.Time{}, true
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

func (n *NetBox) BySerial(ctx context.Context, serial string) (Node, error) {
	if strings.TrimSpace(serial) == "" {
		return Node{}, ErrUnknownNode
	}
	devices, err := n.query(ctx, "&serial="+url.QueryEscape(strings.TrimSpace(serial)))
	if err != nil {
		return Node{}, err
	}
	if len(devices) != 1 {
		if len(devices) == 0 {
			return Node{}, ErrUnknownNode
		}
		return Node{}, fmt.Errorf("NetBox has %d devices with serial %s", len(devices), serial)
	}
	return n.node(ctx, devices[0])
}

func (n *NetBox) ByName(ctx context.Context, name string) (Node, error) {
	devices, err := n.query(ctx, "&name="+url.QueryEscape(name))
	if err != nil {
		return Node{}, err
	}
	for _, d := range devices {
		if d.Name != name {
			continue
		}
		if retired(d.Status.Value) {
			return Node{}, fmt.Errorf("%w: %s is %s", ErrRetired, name, d.Status.Value)
		}
		return n.node(ctx, d)
	}
	return Node{}, ErrUnknownNode
}

// Names lists the devices that have a class, in any status but retired ones.
func (n *NetBox) Names(ctx context.Context) ([]string, error) {
	devices, err := n.query(ctx, "&status=planned&status=staged&status=active&status=failed")
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(devices))
	for _, d := range devices {
		if d.CustomFields.Class != "" {
			names = append(names, d.Name)
		}
	}
	sort.Strings(names)
	return names, nil
}

func (n *NetBox) Spend(ctx context.Context, node Node, at time.Time) error {
	if node.ID == 0 {
		return errors.New("the node has no NetBox id")
	}
	patch := map[string]any{"custom_fields": map[string]any{"attest_consumed_at": at.UTC().Format(time.RFC3339)}}
	return n.do(ctx, http.MethodPatch, fmt.Sprintf("/api/dcim/devices/%d/", node.ID), patch, nil)
}

// Released patches the device, then adds a journal entry. A journal entry
// that fails is logged: the release is recorded by the patch.
func (n *NetBox) Released(ctx context.Context, node Node, at time.Time) error {
	if node.ID == 0 {
		d, err := n.ByName(ctx, node.Name)
		if err != nil {
			return err
		}
		node = d
	}
	patch := map[string]any{"custom_fields": map[string]any{"attest_consumed_at": at.UTC().Format(time.RFC3339)}}
	comment := fmt.Sprintf("talos-enroll: config released to %s at %s", node.Name, at.UTC().Format(time.RFC3339))
	// Only an intake becomes active here. A failed, decommissioning or offline
	// device keeps its status: a release never resurrects one.
	if node.Status == "planned" || node.Status == "staged" {
		patch["status"] = "active"
	} else {
		comment += fmt.Sprintf("; its status stays %s", node.Status)
	}
	if err := n.do(ctx, http.MethodPatch, fmt.Sprintf("/api/dcim/devices/%d/", node.ID), patch, nil); err != nil {
		return err
	}
	if err := n.do(ctx, http.MethodPost, "/api/extras/journal-entries/", map[string]any{
		"assigned_object_type": "dcim.device",
		"assigned_object_id":   node.ID,
		"kind":                 "success",
		"comments":             comment,
	}, nil); err != nil && n.Log != nil {
		n.Log.Warn("the release is recorded, but its journal entry was not written", "node", node.Name, "err", err)
	}
	return nil
}

// Fallback asks NetBox first and the inventory when NetBox fails, so that an
// enrollment by click still works while NetBox is down. An unknown serial in
// NetBox is an answer, not a failure. Writes go to NetBox only.
type Fallback struct {
	Primary   Directory
	Secondary Directory
	Log       *slog.Logger

	mu       sync.Mutex
	degraded bool
}

func (f *Fallback) fall(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.degraded {
		f.Log.Warn("NetBox did not answer, the inventory file answers instead", "err", err)
	}
	f.degraded = true
}

func (f *Fallback) recover() {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.degraded {
		f.Log.Info("NetBox answers again")
	}
	f.degraded = false
}

func answered(err error) bool {
	return err == nil || errors.Is(err, ErrUnknownNode) || errors.Is(err, ErrRetired)
}

func (f *Fallback) BySerial(ctx context.Context, serial string) (Node, error) {
	n, err := f.Primary.BySerial(ctx, serial)
	if answered(err) {
		f.recover()
		return n, err
	}
	f.fall(err)
	return f.Secondary.BySerial(ctx, serial)
}

func (f *Fallback) ByName(ctx context.Context, name string) (Node, error) {
	n, err := f.Primary.ByName(ctx, name)
	if answered(err) {
		f.recover()
		return n, err
	}
	f.fall(err)
	return f.Secondary.ByName(ctx, name)
}

func (f *Fallback) Names(ctx context.Context) ([]string, error) {
	names, err := f.Primary.Names(ctx)
	if err == nil {
		f.recover()
		return names, nil
	}
	f.fall(err)
	return f.Secondary.Names(ctx)
}

func (f *Fallback) Spend(ctx context.Context, n Node, at time.Time) error {
	return f.Primary.Spend(ctx, n, at)
}

func (f *Fallback) Released(ctx context.Context, n Node, at time.Time) error {
	return f.Primary.Released(ctx, n, at)
}
