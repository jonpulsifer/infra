package attest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/jonpulsifer/infra/apps/fleetd/netbox"
	"github.com/jonpulsifer/infra/apps/fleetd/protocol"
)

// NetBox is the system of record for machines and their lifecycle. The
// service reads a machine's class, status, approved binding and EK pins from
// the device with its serial, and writes each verdict to the device's custom
// fields. It never writes the approved binding, which git declares. The local state
// directory stays the cache of what fleetd issued.
type NetBox struct {
	netbox.Client
	Log *slog.Logger
}

// NewNetBox is the NetBox at url, which token opens.
func NewNetBox(url, token string, hc *http.Client, log *slog.Logger) *NetBox {
	return &NetBox{Client: netbox.Client{URL: url, Token: token, HTTP: hc}, Log: log}
}

// fieldEmpty says whether a custom field's raw value is null or a blank
// string.
func fieldEmpty(raw json.RawMessage) bool {
	var s *string
	return json.Unmarshal(raw, &s) == nil && (s == nil || strings.TrimSpace(*s) == "")
}

// pcr0Map reads pcr0_by_bios, a JSON object of BIOS version to PCR 0 hex.
// null, or anything that is not such an object, reads as empty; an entry
// whose value is not a string is dropped.
func pcr0Map(d netbox.Device) map[string]string {
	var raw map[string]any
	_ = json.Unmarshal(d.Field("pcr0_by_bios"), &raw)
	out := map[string]string{}
	for bios, v := range raw {
		if s, ok := v.(string); ok && s != "" {
			out[bios] = strings.ToLower(s)
		}
	}
	return out
}

// PCR0ByBIOS is the PCR 0 the device records for each BIOS version, and
// whether NetBox defines the field at all.
func (n *NetBox) PCR0ByBIOS(ctx context.Context, serial string) (map[string]string, bool, error) {
	d, ok, err := n.device(ctx, serial)
	if err != nil {
		return nil, false, err
	}
	if !ok {
		return nil, false, fmt.Errorf("NetBox has no device with serial %s", serial)
	}
	if d.Field("pcr0_by_bios") == nil {
		return nil, false, nil
	}
	return pcr0Map(d), true, nil
}

func (n *NetBox) device(ctx context.Context, serial string) (netbox.Device, bool, error) {
	return n.SoleBySerial(ctx, serial)
}

func machineOf(d netbox.Device, mac string) Machine {
	return Machine{Name: d.Name, Serial: d.Serial, MAC: normalMAC(mac), Class: d.Class, Status: d.Status, NetBoxID: d.ID, FromNetBox: true,
		Pins:        byAlg(d.EKHash, d.EKHashECC),
		Approved:    byAlg(d.ApprovedEKHash, d.ApprovedEKHashECC),
		Quarantined: strings.HasPrefix(d.Verdict, StatusQuarantined)}
}

// netboxChange is one record of NetBox's changelog, with the custom fields
// of the object before and after the change.
type netboxChange struct {
	ID       int       `json:"id"`
	Time     time.Time `json:"time"`
	UserName string    `json:"user_name"`
	Pre      *struct {
		CustomFields map[string]any `json:"custom_fields"`
	} `json:"prechange_data"`
	Post *struct {
		CustomFields map[string]any `json:"custom_fields"`
	} `json:"postchange_data"`
}

// changesPage and maxChanges bound how much of a device's changelog
// bindingAuthor reads before it gives up.
const (
	changesPage = 200
	maxChanges  = 5000
)

// bindingAuthor is the user who made the newest change to the device's
// approved binding, from NetBox's changelog, newest first. It errs when the
// changelog does not answer, when no record changes the binding, and when
// the newest one that does sets another value than want, as when the
// record that set it was pruned.
func (n *NetBox) bindingAuthor(ctx context.Context, deviceID int, want map[string]string) (string, error) {
	approvedOf := func(data *struct {
		CustomFields map[string]any `json:"custom_fields"`
	}) map[string]string {
		if data == nil {
			return map[string]string{}
		}
		str := func(k string) string { v, _ := data.CustomFields[k].(string); return v }
		return byAlg(str("approved_ek_hash"), str("approved_ek_hash_ecc"))
	}
	for offset := 0; offset < maxChanges; offset += changesPage {
		var page netbox.Page[netboxChange]
		path := fmt.Sprintf("/api/core/object-changes/?changed_object_type=dcim.device&changed_object_id=%d&ordering=-time,-id&limit=%d&offset=%d", deviceID, changesPage, offset)
		if err := n.Do(ctx, http.MethodGet, path, nil, &page); err != nil {
			return "", err
		}
		changes, err := page.Items()
		if err != nil {
			return "", err
		}
		for _, c := range changes {
			post := approvedOf(c.Post)
			if maps.Equal(approvedOf(c.Pre), post) {
				continue
			}
			if !maps.Equal(post, want) {
				return "", fmt.Errorf("the newest change to the binding, %d at %s by %s, does not set its current value", c.ID, c.Time.UTC().Format(time.RFC3339), c.UserName)
			}
			return c.UserName, nil
		}
		if len(changes) == 0 || offset+len(changes) >= *page.Count {
			return "", errors.New("no changelog record sets the binding; NetBox may have pruned it")
		}
	}
	return "", fmt.Errorf("no change to the binding among the device's newest %d changelog records", maxChanges)
}

// byAlg keys an RSA and an ECC EK hash by algorithm, leaving out an empty one.
func byAlg(rsa, ecc string) map[string]string {
	out := map[string]string{}
	if h := strings.ToLower(strings.TrimSpace(rsa)); h != "" {
		out["rsa"] = h
	}
	if h := strings.ToLower(strings.TrimSpace(ecc)); h != "" {
		out["ecc"] = h
	}
	return out
}

// Lookup implements MachineSource.
func (n *NetBox) Lookup(ctx context.Context, serial string) (Machine, bool, error) {
	d, ok, err := n.device(ctx, serial)
	if err != nil || !ok {
		return Machine{}, false, err
	}
	var mac string
	if i, hasMAC, err := n.NIC(ctx, d.ID); err != nil {
		return Machine{}, false, err
	} else if hasMAC {
		mac = i.PrimaryMACAddress.MACAddress
	}
	return machineOf(d, mac), true, nil
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

// intakeName is the name a claim for a serial NetBox lacks waits under: the
// claimed hostname when it reads as one the owner set, else
// intake-<serial slug>.
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

// Bind puts a box's MAC on the declared stub it attested as, the planned
// device the owner entered, and journals a MAC it wrote. The stub keeps its
// name and stays planned until its node fetches its config. It reports whether it wrote the MAC; a MAC
// already on file that is the claim's is no write, and another is
// netbox.ErrMACTaken.
func (n *NetBox) Bind(ctx context.Context, deviceID int, claim protocol.Machine) (bool, error) {
	mac := normalMAC(claim.MAC)
	if !netbox.ValidMAC(mac) {
		return false, fmt.Errorf("MAC %q does not read as one", claim.MAC)
	}
	wrote, err := n.SetMAC(ctx, deviceID, mac)
	if err != nil || !wrote {
		return false, err
	}
	n.journalLater(ctx, deviceID, "info", netbox.Plain(fmt.Sprintf("fleetd: bound to the box that attested as its serial (serial %s, MAC %s, %s %s)", claim.Serial, mac, claim.Manufacturer, claim.Model)), claim.Serial)
	return true, nil
}

// Record implements Recorder: the verdict and the issued serials go to the
// device's custom fields before the machine gets its answer. Only a pass
// whose session proved the EKs writes the pins: the approved binding it
// matched, or else only an empty pin, and only a pass refreshes
// sku and bios_version. A hourly check's pass writes only the verdict, its
// time and what the quote showed for PCR 0. A quarantine writes only its
// verdict, which revokes the identity and which fleetd cordons the
// node on; the status stays. A pass leaves the status alone too. The
// journal entry follows on its own.
func (n *NetBox) Record(ctx context.Context, r Record) error {
	d, ok, err := n.device(ctx, r.Serial)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("NetBox has no device with serial %s", r.Serial)
	}
	p, err := planRecord(d, r)
	if err != nil {
		return err
	}
	for i, e := range p.early {
		if p.warn[i] != nil && n.Log != nil {
			n.Log.Warn("NetBox pin kept", p.warn[i]...)
		}
		n.journalLater(ctx, d.ID, e[0], e[1], r.Serial)
	}
	if err := n.Patch(ctx, d.ID, "", p.fields); err != nil {
		return err
	}
	if p.kind != "" {
		n.journalLater(ctx, d.ID, p.kind, p.comment, r.Serial)
	}
	for _, note := range p.notes {
		n.journalLater(ctx, d.ID, note[0], note[1], r.Serial)
	}
	return nil
}

// recordPlan is what a record writes to its device: the custom fields, the
// journal entries that go before the write (with the log line each pairs
// with, or nil), the entry for the verdict itself and the entries that follow.
type recordPlan struct {
	fields        map[string]any
	early         [][2]string
	warn          [][]any
	kind, comment string
	notes         [][2]string
}

// planRecord is the pure part of Record: the fields and journal entries the
// record writes to the device d.
func planRecord(d netbox.Device, r Record) (recordPlan, error) {
	fields := map[string]any{}
	var p recordPlan
	var kind, comment string
	switch {
	case r.unquarantined:
		// A control-plane node keeps its identity and is not cordoned: it
		// serves the cluster's API.
		fields["attest_verdict"] = fmt.Sprintf("%s: %s", protocol.VerdictFailedNoQuarantine, r.CheckFailed)
		kind, comment = "danger", fmt.Sprintf("fleetd: failed attestation (%s) and not quarantined, since %s is a control-plane node: %s", r.CheckFailed, d.Name, netbox.Plain(strings.Join(r.Detail, "; ")))
	case r.Status == StatusAttested && r.check:
		// A hourly check issues nothing: the verdict and its time are all it
		// writes, besides what the quote showed for PCR 0. A routine pass
		// leaves no journal entry. A device quarantined since the check
		// started stays as it is.
		if d.Status == statusFailed || strings.HasPrefix(d.Verdict, StatusQuarantined) {
			return recordPlan{}, fmt.Errorf("%s was quarantined during the check; the pass is not recorded", d.Name)
		}
		fields["attest_verdict"] = StatusAttested
		fields["last_attested"] = r.AttestedAt.UTC().Format(time.RFC3339)
	case r.Status == StatusAttested:
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
			// A pass that matched an approved binding pins the binding alone:
			// each approved hash, and no pin for an algorithm it leaves out,
			// so a removed TPM's EK and an extra EK the pass sent stay
			// unpinned. Without a binding a pin on file is kept, and only an
			// empty one is written.
			for _, pin := range []struct{ field, alg, cur string }{{"ek_hash", "rsa", d.EKHash}, {"ek_hash_ecc", "ecc", d.EKHashECC}} {
				cur := strings.ToLower(strings.TrimSpace(pin.cur))
				if len(r.approved) > 0 {
					want := r.approved[pin.alg]
					switch {
					case want == cur:
					case want != "":
						fields[pin.field] = want
					default:
						fields[pin.field] = nil
						p.early = append(p.early, [2]string{"info", fmt.Sprintf("fleetd: cleared %s %s, which the approved binding does not name", pin.field, cur)})
						p.warn = append(p.warn, nil)
					}
					continue
				}
				h := r.EKHashes[pin.alg]
				switch {
				case h == "" || cur == h:
				case cur == "":
					fields[pin.field] = h
				default:
					comment := fmt.Sprintf("fleetd: kept %s %s; the pass proved %s", pin.field, cur, h)
					p.early = append(p.early, [2]string{"warning", comment})
					p.warn = append(p.warn, []any{"serial", r.Serial, "field", pin.field, "on_file", pin.cur, "proved", h})
				}
			}
			if len(r.EKIssuers) > 0 {
				fields["ek_issuer"] = strings.Join(r.EKIssuers, ", ")
			}
			// fleetd keys the config by this UUID. NetBox
			// refuses a custom field it does not define, so the verdict
			// never waits for terraform/netbox/folly to add it.
			if u, ok := smbiosUUID(r.UUID); ok && d.Field("smbios_uuid") != nil {
				fields["smbios_uuid"] = u
			}
			// Activating a credential against the EK proves a TPM 2.0, which
			// a stub declared without the fact lacks. An owner's value stays.
			if d.Field("tpm_version") != nil && fieldEmpty(d.Field("tpm_version")) {
				fields["tpm_version"] = "2.0"
			}
		}
		if !r.Renewed {
			networkFields(d, r, fields)
		}
		kind, comment = "success", fmt.Sprintf("fleetd: attested; LDevID %s, LAK %s", r.LDevIDSerial, r.LAKSerial)
		if r.Renewed {
			comment = fmt.Sprintf("fleetd: renewed; LDevID %s, LAK %s", r.LDevIDSerial, r.LAKSerial)
		}
	case r.Status == StatusQuarantined:
		fields["attest_verdict"] = fmt.Sprintf("%s: %s", StatusQuarantined, r.Reason)
		kind, comment = "danger", fmt.Sprintf("fleetd: quarantined (%s); fleetd serves no LDevID for it until the owner clears attest_verdict: %s", r.Reason, netbox.Plain(strings.Join(r.Detail, "; ")))
	default:
		return recordPlan{}, fmt.Errorf("a record with status %q is not a verdict", r.Status)
	}
	if r.Status == StatusAttested {
		p.notes = pcr0Fields(d, r, fields)
		p.notes = append(p.notes, bootFields(d, r, fields)...)
	}
	p.fields, p.kind, p.comment = fields, kind, comment
	return p, nil
}

// pcr0Fields records what a running node's quote showed: the BIOS version
// it reported, and its PCR 0 under that version when pcr0_by_bios holds
// none yet. A PCR 0 that differs from the one on file for the same version
// is never written over: the entry stays until the owner explains the
// change by editing it, and each check journals it again until then. It
// answers the journal entries, by kind and comment.
func pcr0Fields(d netbox.Device, r Record, fields map[string]any) [][2]string {
	p := r.pcr0
	if p == nil {
		return nil
	}
	var notes [][2]string
	bios := netbox.Plain(p.BIOS)
	if was := d.BIOSVersion; was != p.BIOS {
		fields["bios_version"] = p.BIOS
		if was != "" {
			notes = append(notes, [2]string{"info", fmt.Sprintf("fleetd: BIOS version is %s, was %s", bios, netbox.Plain(was))})
		}
	}
	if d.Field("pcr0_by_bios") == nil {
		return notes
	}
	// The owner's entries go back as they were; only the new key is added.
	raw := map[string]json.RawMessage{}
	if err := json.Unmarshal(d.Field("pcr0_by_bios"), &raw); err != nil || raw == nil {
		if string(d.Field("pcr0_by_bios")) != "null" {
			return append(notes, [2]string{"warning", "fleetd: pcr0_by_bios is not a JSON object; PCR 0 is not recorded"})
		}
		raw = map[string]json.RawMessage{}
	}
	_, present := raw[p.BIOS]
	switch cur, ok := pcr0Map(d)[p.BIOS]; {
	case !ok && present:
		// An entry the owner wrote that is not a digest stays untouched.
	case !ok:
		raw[p.BIOS], _ = json.Marshal(p.PCR0)
		fields["pcr0_by_bios"] = raw
		notes = append(notes, [2]string{"info", fmt.Sprintf("fleetd: PCR 0 at BIOS %s recorded as %s", bios, p.PCR0)})
	case !strings.EqualFold(cur, p.PCR0):
		notes = append(notes, [2]string{"warning", fmt.Sprintf("fleetd: PCR 0 at BIOS %s is %s, not the %s on record, and no BIOS update explains it. Not quarantined: once the change is explained, set this BIOS version's entry in pcr0_by_bios to the new value", bios, p.PCR0, netbox.Plain(cur))})
	}
	return notes
}

// bootFields records the dbx and SBAT hashes a pass measured, in the fields
// NetBox defines. A value that differs from the one on file replaces it and
// leaves a warning, since only the owner can say whether a firmware or shim
// update explains it. It never fails a pass.
func bootFields(d netbox.Device, r Record, fields map[string]any) [][2]string {
	var notes [][2]string
	for _, f := range []struct {
		field, label, got string
		raw               json.RawMessage
	}{
		{"dbx_hash", "dbx", r.Boot.DBX, d.Field("dbx_hash")},
		{"sbat_level", "SBAT level", r.Boot.SBAT, d.Field("sbat_level")},
	} {
		if f.got == "" || f.raw == nil {
			continue
		}
		var cur string
		_ = json.Unmarshal(f.raw, &cur)
		if strings.EqualFold(cur, f.got) {
			continue
		}
		fields[f.field] = f.got
		if cur != "" {
			notes = append(notes, [2]string{"warning", fmt.Sprintf("fleetd: the %s hash is %s, was %s. Not quarantined: a firmware or shim update explains it, or nothing does", f.label, f.got, netbox.Plain(cur))})
		}
	}
	return notes
}

// networkFields writes where an intake pass found the machine plugged in, as
// its AK signed it, into each network field NetBox defines. A pass without
// a fact clears its field, so no older address or port outlives a newer
// pass. fleetd cables the machine to the port; the address is for
// the owner.
func networkFields(d netbox.Device, r Record, fields map[string]any) {
	var addr, chassis, port, at any
	if n := r.Network; n != nil {
		if n.Address != "" {
			addr = n.Address
		}
		if n.LLDP != nil {
			chassis, port = n.LLDP.ChassisID, n.LLDP.PortID
		}
		at = r.AttestedAt.UTC().Format(time.RFC3339)
	}
	for _, f := range []struct {
		name    string
		defined json.RawMessage
		value   any
	}{
		{"attested_address", d.Field("attested_address"), addr},
		{"attested_switch", d.Field("attested_switch"), chassis},
		{"attested_switch_port", d.Field("attested_switch_port"), port},
		{"attested_network_at", d.Field("attested_network_at"), at},
	} {
		if f.defined != nil {
			fields[f.name] = f.value
		}
	}
}

// journalLater posts a journal entry on its own: the journal is history,
// not state, and need not hold up the answer.
func (n *NetBox) journalLater(ctx context.Context, deviceID int, kind, comment, serial string) {
	go func() {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
		defer cancel()
		if err := n.Journal(ctx, deviceID, kind, comment); err != nil && n.Log != nil {
			n.Log.Warn("NetBox journal", "serial", serial, "err", err)
		}
	}()
}

// Backfill writes a pass fleetd holds to a device whose verdict is
// empty, as after the verdict fields were created in NetBox. A non-empty
// verdict, and a device being decommissioned or offline, are never touched.
// It reports whether it wrote.
func (n *NetBox) Backfill(ctx context.Context, r Record) (bool, error) {
	d, ok, err := n.device(ctx, r.Serial)
	if err != nil || !ok {
		return false, err
	}
	if d.Verdict != "" || d.Status == statusDecommissioning || d.Status == statusOffline {
		return false, nil
	}
	fields := map[string]any{
		"attest_verdict": StatusAttested,
		"last_attested":  r.AttestedAt.UTC().Format(time.RFC3339),
		"ldevid_serial":  r.LDevIDSerial,
		"lak_serial":     r.LAKSerial,
	}
	if !r.LDevIDNotAfter.IsZero() {
		fields["ldevid_not_after"] = r.LDevIDNotAfter.UTC().Format(time.DateOnly)
	}
	if err := n.Patch(ctx, d.ID, "", fields); err != nil {
		return false, err
	}
	n.journalLater(ctx, d.ID, "info", fmt.Sprintf("fleetd: verdict backfilled from fleetd's record; LDevID %s, LAK %s, attested %s", r.LDevIDSerial, r.LAKSerial, r.AttestedAt.UTC().Format(time.RFC3339)), r.Serial)
	return true, nil
}

// MarkPending notes on the device that an intake waits for its approved binding.
// A claim proved nothing, so it writes neither status nor pins, and never
// over a pass on file: the device's verdict stays attested.
func (n *NetBox) MarkPending(ctx context.Context, serial, detail string) error {
	d, ok, err := n.device(ctx, serial)
	if err != nil || !ok {
		return err
	}
	if d.Verdict == StatusAttested || strings.HasPrefix(d.Verdict, protocol.VerdictFailedNoQuarantine) {
		return nil
	}
	// A quarantine stands until the owner clears it; the claim is only journaled.
	if !strings.HasPrefix(d.Verdict, StatusQuarantined) {
		if err := n.Patch(ctx, d.ID, "", map[string]any{"attest_verdict": StatusPending}); err != nil {
			return err
		}
	}
	n.journalLater(ctx, d.ID, "warning", "fleetd: an intake waits for an approved EK binding in the nodes file: "+netbox.Plain(detail), serial)
	return nil
}

// Verdict reads a machine's newest verdict from its device. A device with
// no verdict, one that waits for approval, or one retired, is not found.
func (n *NetBox) Verdict(ctx context.Context, serial string) (protocol.Status, bool, error) {
	d, ok, err := n.device(ctx, serial)
	if err != nil || !ok {
		return protocol.Status{}, false, err
	}
	switch d.Status {
	case statusDecommissioning, statusOffline:
		return protocol.Status{}, false, nil
	}
	st := protocol.Status{Node: d.Name, Class: d.Class, Site: d.Site, UpdatedAt: d.LastUpdated, LDevIDSerial: strings.ToLower(d.LDevIDSerial)}
	switch v := d.Verdict; {
	case v == StatusAttested, strings.HasPrefix(v, protocol.VerdictFailedNoQuarantine):
		// A control-plane node that failed in place keeps its identity.
		st.Status = protocol.StatusAttested
	case strings.HasPrefix(v, StatusQuarantined):
		st.Status = protocol.StatusQuarantined
	default:
		return protocol.Status{}, false, nil
	}
	st.AttestedAt, _ = time.Parse(time.RFC3339, d.LastAttested)
	st.ConsumedAt, _ = time.Parse(time.RFC3339, d.ConsumedAt)
	return st, true, nil
}
