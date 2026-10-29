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
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/jonpulsifer/infra/apps/talos-attest/protocol"
)

// NetBox is the system of record for machines and their lifecycle. The
// service reads a machine's class, status and EK pins from the device with
// its serial, creates a device at staged for a serial NetBox has never seen,
// and writes each verdict to the device's custom fields. The local state
// directory stays the cache of what this anchor issued.
type NetBox struct {
	URL    string
	Token  string
	Client *http.Client
	// Site and Role are the slugs a created device gets.
	Site string
	Role string
	Log  *slog.Logger
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
		return &netboxError{Status: resp.StatusCode, Msg: fmt.Sprintf("%s %s: %s: %s", method, path, resp.Status, strings.TrimSpace(string(msg)))}
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}

type netboxError struct {
	Status int
	Msg    string
}

func (e *netboxError) Error() string { return e.Msg }

// netboxDevice is the part of a dcim.device the service reads.
type netboxDevice struct {
	ID     int    `json:"id"`
	Name   string `json:"name"`
	Serial string `json:"serial"`
	Status struct {
		Value string `json:"value"`
	} `json:"status"`
	Site struct {
		ID   int    `json:"id"`
		Slug string `json:"slug"`
	} `json:"site"`
	LastUpdated  time.Time `json:"last_updated"`
	CustomFields struct {
		EKHash       string   `json:"ek_hash"`
		EKHashECC    string   `json:"ek_hash_ecc"`
		Class        nbSelect `json:"talos_class"`
		Verdict      string   `json:"attest_verdict"`
		LastAttested string   `json:"last_attested"`
		ConsumedAt   string   `json:"attest_consumed_at"`
		LDevIDSerial string   `json:"ldevid_serial"`
		LAKSerial    string   `json:"lak_serial"`
		SKU          string   `json:"sku"`
		BIOSVersion  string   `json:"bios_version"`
	} `json:"custom_fields"`
}

// nbSelect is a selection custom field, which NetBox serializes as the
// chosen value, or as {value, label} in some versions and the export.
type nbSelect string

func (s *nbSelect) UnmarshalJSON(b []byte) error {
	var str string
	if err := json.Unmarshal(b, &str); err == nil {
		*s = nbSelect(str)
		return nil
	}
	var obj struct {
		Value string `json:"value"`
	}
	if err := json.Unmarshal(b, &obj); err != nil {
		*s = ""
		return nil
	}
	*s = nbSelect(obj.Value)
	return nil
}

// netboxPage is one page of a list. A page without count or results is not
// an answer: a 200 with {} or null never reads as "no such device".
type netboxPage[T any] struct {
	Count   *int `json:"count"`
	Results *[]T `json:"results"`
}

func (p netboxPage[T]) items() ([]T, error) {
	if p.Count == nil || p.Results == nil {
		return nil, errors.New("NetBox answered a page without count or results")
	}
	return *p.Results, nil
}

type netboxRef struct {
	ID int `json:"id"`
}

type netboxInterface struct {
	ID                int    `json:"id"`
	Name              string `json:"name"`
	PrimaryMACAddress *struct {
		ID         int    `json:"id"`
		MACAddress string `json:"mac_address"`
	} `json:"primary_mac_address"`
}

func (n *NetBox) device(ctx context.Context, serial string) (netboxDevice, bool, error) {
	var page netboxPage[netboxDevice]
	if err := n.do(ctx, http.MethodGet, "/api/dcim/devices/?limit=2&serial="+url.QueryEscape(serial), nil, &page); err != nil {
		return netboxDevice{}, false, err
	}
	results, err := page.items()
	if err != nil {
		return netboxDevice{}, false, err
	}
	if *page.Count == 0 && len(results) == 0 {
		return netboxDevice{}, false, nil
	}
	if *page.Count != 1 || len(results) != 1 {
		return netboxDevice{}, false, fmt.Errorf("NetBox has %d devices with serial %s", *page.Count, serial)
	}
	return results[0], true, nil
}

// nic is the device's first interface with a primary MAC.
func (n *NetBox) nic(ctx context.Context, deviceID int) (netboxInterface, bool, error) {
	var page netboxPage[netboxInterface]
	if err := n.do(ctx, http.MethodGet, fmt.Sprintf("/api/dcim/interfaces/?limit=50&device_id=%d", deviceID), nil, &page); err != nil {
		return netboxInterface{}, false, err
	}
	results, err := page.items()
	if err != nil {
		return netboxInterface{}, false, err
	}
	sort.Slice(results, func(i, j int) bool { return results[i].ID < results[j].ID })
	for _, i := range results {
		if i.PrimaryMACAddress != nil && i.PrimaryMACAddress.MACAddress != "" {
			return i, true, nil
		}
	}
	if len(results) > 0 {
		return results[0], false, nil
	}
	return netboxInterface{}, false, nil
}

func (d netboxDevice) machine(mac string) Machine {
	m := Machine{Name: d.Name, Serial: d.Serial, MAC: normalMAC(mac), Class: string(d.CustomFields.Class), Status: d.Status.Value, NetBoxID: d.ID, FromNetBox: true, Pins: map[string]string{}}
	if h := strings.ToLower(d.CustomFields.EKHash); h != "" {
		m.Pins["rsa"] = h
	}
	if h := strings.ToLower(d.CustomFields.EKHashECC); h != "" {
		m.Pins["ecc"] = h
	}
	return m
}

// Lookup implements MachineSource.
func (n *NetBox) Lookup(ctx context.Context, serial string) (Machine, bool, error) {
	d, ok, err := n.device(ctx, serial)
	if err != nil || !ok {
		return Machine{}, false, err
	}
	var mac string
	if i, hasMAC, err := n.nic(ctx, d.ID); err != nil {
		return Machine{}, false, err
	} else if hasMAC {
		mac = i.PrimaryMACAddress.MACAddress
	}
	return d.machine(mac), true, nil
}

var hostnameRE = regexp.MustCompile(`^[a-z][a-z0-9-]{0,62}$`)

// serialSlug is a claimed serial as one safe name element: letters, digits
// and hyphens stay, lower-cased, and anything else is its hex. A serial is
// a claim until the TPM proves it, and it must never become a path.
func serialSlug(serial string) string {
	var b strings.Builder
	for _, r := range serialKey(serial) {
		switch {
		case r >= 'A' && r <= 'Z':
			b.WriteRune(r + 'a' - 'A')
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-':
			b.WriteRune(r)
		default:
			fmt.Fprintf(&b, "x%x", r)
		}
	}
	return b.String()
}

// intakeName is the name a device created on first sight gets: the claimed
// hostname when it reads as one the owner set, else intake-<serial slug>.
func intakeName(claim protocol.Machine) string {
	h := strings.ToLower(strings.TrimSpace(claim.Hostname))
	switch h {
	case "", "localhost", "hookos", "hook", "(none)", "tink", "talos":
		return "intake-" + serialSlug(claim.Serial)
	}
	if !hostnameRE.MatchString(h) {
		return "intake-" + serialSlug(claim.Serial)
	}
	return h
}

// Create adds a device at staged for a serial NetBox has never seen, with
// the device type the SMBIOS model names, made under its manufacturer when
// NetBox lacks it, and the NIC's MAC on its first interface.
func (n *NetBox) Create(ctx context.Context, claim protocol.Machine) (Machine, error) {
	siteID, err := n.idBy(ctx, "/api/dcim/sites/", "slug", n.Site)
	if err != nil {
		return Machine{}, err
	}
	roleID, err := n.idBy(ctx, "/api/dcim/device-roles/", "slug", n.Role)
	if err != nil {
		return Machine{}, err
	}
	typeID, err := n.deviceType(ctx, claim)
	if err != nil {
		return Machine{}, err
	}
	fields := map[string]any{}
	if claim.SKU != "" {
		fields["sku"] = claim.SKU
	}
	if claim.BIOS != "" {
		fields["bios_version"] = claim.BIOS
	}
	body := map[string]any{
		"name":          intakeName(claim),
		"device_type":   typeID,
		"role":          roleID,
		"site":          siteID,
		"status":        statusStaged,
		"serial":        serialKey(claim.Serial),
		"custom_fields": fields,
		"comments":      "Created by talos-attest on first sight, after its TPM activated a credential.",
	}
	var d netboxDevice
	if err := n.do(ctx, http.MethodPost, "/api/dcim/devices/", body, &d); err != nil {
		var ne *netboxError
		if !asNetboxError(err, &ne) || ne.Status != http.StatusBadRequest || body["name"] == "intake-"+serialSlug(claim.Serial) {
			return Machine{}, err
		}
		// The claimed hostname is taken; fall back to the serial.
		body["name"] = "intake-" + serialSlug(claim.Serial)
		if err := n.do(ctx, http.MethodPost, "/api/dcim/devices/", body, &d); err != nil {
			return Machine{}, err
		}
	}
	mac := normalMAC(claim.MAC)
	if mac != "" {
		if err := n.setMAC(ctx, d.ID, mac); err != nil {
			return Machine{}, fmt.Errorf("device %d created, MAC not set: %w", d.ID, err)
		}
	}
	if err := n.journal(ctx, d.ID, "info", plain(fmt.Sprintf("talos-attest: created on first sight from HookOS, after credential activation (serial %s, MAC %s, %s %s)", claim.Serial, mac, claim.Manufacturer, claim.Model))); err != nil {
		return Machine{}, err
	}
	d.Status.Value = statusStaged
	d.Serial = serialKey(claim.Serial)
	return d.machine(mac), nil
}

func asNetboxError(err error, target **netboxError) bool {
	return errors.As(err, target)
}

// setMAC puts mac on the device's first interface as its primary MAC, making
// an interface when the device type's templates made none.
func (n *NetBox) setMAC(ctx context.Context, deviceID int, mac string) error {
	i, hasMAC, err := n.nic(ctx, deviceID)
	if err != nil {
		return err
	}
	if hasMAC {
		if normalMAC(i.PrimaryMACAddress.MACAddress) == mac {
			return nil
		}
		return fmt.Errorf("interface %s already has MAC %s", i.Name, i.PrimaryMACAddress.MACAddress)
	}
	if i.ID == 0 {
		if err := n.do(ctx, http.MethodPost, "/api/dcim/interfaces/", map[string]any{"device": deviceID, "name": "eth0", "type": "1000base-t"}, &i); err != nil {
			return err
		}
	}
	var m netboxRef
	if err := n.do(ctx, http.MethodPost, "/api/dcim/mac-addresses/", map[string]any{
		"mac_address":          strings.ToUpper(mac),
		"assigned_object_type": "dcim.interface",
		"assigned_object_id":   i.ID,
	}, &m); err != nil {
		return err
	}
	return n.do(ctx, http.MethodPatch, fmt.Sprintf("/api/dcim/interfaces/%d/", i.ID), map[string]any{"primary_mac_address": m.ID}, nil)
}

// deviceType finds the type whose model the claim names, or makes it under
// its manufacturer. With no model in the claim it is an error: a device
// needs a type.
func (n *NetBox) deviceType(ctx context.Context, claim protocol.Machine) (int, error) {
	model := strings.TrimSpace(claim.Model)
	if model == "" {
		return 0, fmt.Errorf("the claim names no SMBIOS model, which a new NetBox device needs")
	}
	var page netboxPage[netboxRef]
	if err := n.do(ctx, http.MethodGet, "/api/dcim/device-types/?limit=2&model="+url.QueryEscape(model), nil, &page); err != nil {
		return 0, err
	}
	types, err := page.items()
	if err != nil {
		return 0, err
	}
	if len(types) > 0 {
		return types[0].ID, nil
	}
	mfr := strings.TrimSpace(claim.Manufacturer)
	if mfr == "" {
		mfr = "Unknown"
	}
	mfrID, err := n.ensure(ctx, "/api/dcim/manufacturers/", "name", mfr, map[string]any{"name": mfr, "slug": slugify(mfr)})
	if err != nil {
		return 0, err
	}
	body := map[string]any{"manufacturer": mfrID, "model": model, "slug": slugify(model)}
	if claim.SKU != "" {
		body["part_number"] = claim.SKU
	}
	var t netboxRef
	if err := n.do(ctx, http.MethodPost, "/api/dcim/device-types/", body, &t); err != nil {
		return 0, err
	}
	return t.ID, nil
}

func (n *NetBox) idBy(ctx context.Context, path, field, value string) (int, error) {
	var page netboxPage[netboxRef]
	if err := n.do(ctx, http.MethodGet, path+"?limit=2&"+field+"="+url.QueryEscape(value), nil, &page); err != nil {
		return 0, err
	}
	results, err := page.items()
	if err != nil {
		return 0, err
	}
	if len(results) == 0 {
		return 0, &netboxError{Status: http.StatusNotFound, Msg: fmt.Sprintf("NetBox has no %s with %s %q", strings.Trim(strings.TrimPrefix(path, "/api/dcim/"), "/"), field, value)}
	}
	return results[0].ID, nil
}

func (n *NetBox) ensure(ctx context.Context, path, field, value string, body map[string]any) (int, error) {
	id, err := n.idBy(ctx, path, field, value)
	if err == nil {
		return id, nil
	}
	var ne *netboxError
	if !asNetboxError(err, &ne) || ne.Status != http.StatusNotFound {
		return 0, err
	}
	var r netboxRef
	if err := n.do(ctx, http.MethodPost, path, body, &r); err != nil {
		return 0, err
	}
	return r.ID, nil
}

var slugRE = regexp.MustCompile(`[^a-z0-9]+`)

func slugify(s string) string {
	return strings.Trim(slugRE.ReplaceAllString(strings.ToLower(s), "-"), "-")
}

func (n *NetBox) journal(ctx context.Context, deviceID int, kind, comment string) error {
	return n.do(ctx, http.MethodPost, "/api/extras/journal-entries/", map[string]any{
		"assigned_object_type": "dcim.device",
		"assigned_object_id":   deviceID,
		"kind":                 kind,
		"comments":             comment,
	}, nil)
}

// plain strips what NetBox's journal would render as Markdown, and line
// breaks, from text a machine claimed.
func plain(s string) string {
	return strings.Map(func(r rune) rune {
		if r < ' ' || strings.ContainsRune("*_`#[]()<>|~\\", r) {
			return ' '
		}
		return r
	}, s)
}

// Record implements Recorder: the verdict and the issued serials go to the
// device's custom fields before the machine gets its answer. Only a pass
// whose session proved the EKs writes the pins, and only a pass refreshes
// sku and bios_version. A quarantine fails the device; a verdict on a
// planned device stages it. The journal entry follows on its own.
func (n *NetBox) Record(ctx context.Context, r Record) error {
	d, ok, err := n.device(ctx, r.Serial)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("NetBox has no device with serial %s", r.Serial)
	}
	fields := map[string]any{}
	patch := map[string]any{}
	var kind, comment string
	switch r.Status {
	case StatusAttested:
		fields["attest_verdict"] = StatusAttested
		fields["ldevid_serial"] = r.LDevIDSerial
		fields["ldevid_not_after"] = r.LDevIDNotAfter.UTC().Format(time.DateOnly)
		fields["lak_serial"] = r.LAKSerial
		fields["last_attested"] = r.AttestedAt.UTC().Format(time.RFC3339)
		if r.SKU != "" {
			fields["sku"] = r.SKU
		}
		if r.BIOS != "" {
			fields["bios_version"] = r.BIOS
		}
		if r.EKProven {
			if h := r.EKHashes["rsa"]; h != "" {
				fields["ek_hash"] = h
			}
			if h := r.EKHashes["ecc"]; h != "" {
				fields["ek_hash_ecc"] = h
			}
			if len(r.EKIssuers) > 0 {
				fields["ek_issuer"] = strings.Join(r.EKIssuers, ", ")
			}
		}
		if d.Status.Value == statusPlanned {
			patch["status"] = statusStaged
		}
		kind, comment = "success", fmt.Sprintf("talos-attest: attested; LDevID %s, LAK %s", r.LDevIDSerial, r.LAKSerial)
		if r.Renewed {
			comment = fmt.Sprintf("talos-attest: renewed; LDevID %s, LAK %s", r.LDevIDSerial, r.LAKSerial)
		}
	case StatusQuarantined:
		fields["attest_verdict"] = fmt.Sprintf("%s: %s", StatusQuarantined, r.Reason)
		patch["status"] = statusFailed
		kind, comment = "danger", fmt.Sprintf("talos-attest: quarantined (%s): %s", r.Reason, plain(strings.Join(r.Detail, "; ")))
	default:
		return fmt.Errorf("a record with status %q is not a verdict", r.Status)
	}
	patch["custom_fields"] = fields
	if err := n.do(ctx, http.MethodPatch, fmt.Sprintf("/api/dcim/devices/%d/", d.ID), patch, nil); err != nil {
		return err
	}
	n.journalLater(ctx, d.ID, kind, comment, r.Serial)
	return nil
}

// journalLater posts a journal entry on its own: the journal is history,
// not state, and need not hold up the answer.
func (n *NetBox) journalLater(ctx context.Context, deviceID int, kind, comment, serial string) {
	go func() {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
		defer cancel()
		if err := n.journal(ctx, deviceID, kind, comment); err != nil && n.Log != nil {
			n.Log.Warn("NetBox journal", "serial", serial, "err", err)
		}
	}()
}

// Backfill writes a pass this anchor holds to a device whose verdict is
// empty, as after the verdict fields were created in NetBox. A non-empty
// verdict is never touched. It reports whether it wrote.
func (n *NetBox) Backfill(ctx context.Context, r Record) (bool, error) {
	d, ok, err := n.device(ctx, r.Serial)
	if err != nil || !ok {
		return false, err
	}
	if d.CustomFields.Verdict != "" {
		return false, nil
	}
	fields := map[string]any{
		"attest_verdict": StatusAttested,
		"last_attested":  r.AttestedAt.UTC().Format(time.RFC3339),
		"ldevid_serial":  r.LDevIDSerial,
		"lak_serial":     r.LAKSerial,
	}
	if err := n.do(ctx, http.MethodPatch, fmt.Sprintf("/api/dcim/devices/%d/", d.ID), map[string]any{"custom_fields": fields}, nil); err != nil {
		return false, err
	}
	n.journalLater(ctx, d.ID, "info", fmt.Sprintf("talos-attest: verdict backfilled from the anchor's record; LDevID %s, LAK %s, attested %s", r.LDevIDSerial, r.LAKSerial, r.AttestedAt.UTC().Format(time.RFC3339)), r.Serial)
	return true, nil
}

// MarkPending notes on the device that a first intake waits for the owner.
// A claim proved nothing, so it writes neither status nor pins, and never
// over a pass on file: the device's verdict stays attested.
func (n *NetBox) MarkPending(ctx context.Context, serial, detail string) error {
	d, ok, err := n.device(ctx, serial)
	if err != nil || !ok {
		return err
	}
	if d.CustomFields.Verdict == StatusAttested {
		return nil
	}
	// A quarantine stands until the owner clears it; the claim is only journaled.
	if !strings.HasPrefix(d.CustomFields.Verdict, StatusQuarantined) {
		if err := n.do(ctx, http.MethodPatch, fmt.Sprintf("/api/dcim/devices/%d/", d.ID), map[string]any{"custom_fields": map[string]any{"attest_verdict": StatusPending}}, nil); err != nil {
			return err
		}
	}
	n.journalLater(ctx, d.ID, "warning", "talos-attest: first intake waits for the owner's approval: "+plain(detail), serial)
	return nil
}

// Verdict reads a machine's newest verdict from its device. A device with
// no verdict, one that waits for approval, or one retired, is not found.
func (n *NetBox) Verdict(ctx context.Context, serial string) (protocol.Status, bool, error) {
	d, ok, err := n.device(ctx, serial)
	if err != nil || !ok {
		return protocol.Status{}, false, err
	}
	switch d.Status.Value {
	case statusDecommissioning, statusOffline:
		return protocol.Status{}, false, nil
	}
	st := protocol.Status{Node: d.Name, Class: string(d.CustomFields.Class), Site: d.Site.Slug, UpdatedAt: d.LastUpdated}
	switch v := d.CustomFields.Verdict; {
	case v == StatusAttested:
		st.Status = protocol.StatusAttested
	case strings.HasPrefix(v, StatusQuarantined):
		st.Status = protocol.StatusQuarantined
	default:
		return protocol.Status{}, false, nil
	}
	st.AttestedAt, _ = time.Parse(time.RFC3339, d.CustomFields.LastAttested)
	st.ConsumedAt, _ = time.Parse(time.RFC3339, d.CustomFields.ConsumedAt)
	return st, true, nil
}
