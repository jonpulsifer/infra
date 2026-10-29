package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/netip"
	"sort"
	"strings"
)

// Model is what the model map says of one SMBIOS model: the class, BMC and
// install disk a machine of that model gets on intake.
type Model struct {
	Class string `json:"class"`
	BMC   string `json:"bmc"`
	Disk  string `json:"disk"`
}

// DefaultModels is FLEET_MODEL_MAP when the environment sets none.
var DefaultModels = map[string]Model{
	"HP EliteDesk 800 G5 Desktop Mini": {Class: "worker-g5", BMC: "amt", Disk: "/dev/nvme0n1"},
}

// ParseModels reads FLEET_MODEL_MAP.
func ParseModels(s string) (map[string]Model, error) {
	if strings.TrimSpace(s) == "" {
		return DefaultModels, nil
	}
	var m map[string]Model
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		return nil, fmt.Errorf("FLEET_MODEL_MAP: %w", err)
	}
	return m, nil
}

const (
	intakeName = "intake-"
	// bindMarker on a device's description names the stub it is taking
	// over, so a pass that stops between deleting the stub and renaming the
	// device finishes the rename on the next.
	bindMarker = "fleet-controller: binds stub "
)

// Stub says whether a device is a stub: a planned device with no MAC, which
// declares a name, a class and maybe a serial, a port and an address for a
// machine that has not phoned home yet.
func (d Device) Stub() bool { return d.Status == "planned" && d.MAC == "" }

// FromIntake says whether the device's newest run is its intake: it sits in
// HookOS, and no provision has run since.
func (d Device) FromIntake() bool { return strings.HasPrefix(d.LastWorkflow, ActionIntake+"-") }

// bindPass is one pass's state for binding: the stubs not taken yet, and
// UniFi's clients and NetBox's switches, each read once and only when a
// binding needs them.
type bindPass struct {
	stubs []Device

	stations       []Station
	stationsErr    error
	stationsRead   bool
	switches       []Switch
	switchesErr    error
	switchesRead   bool
	allocatedAddrs map[string]bool
}

func newBindPass(devices []Device) *bindPass {
	p := &bindPass{allocatedAddrs: map[string]bool{}}
	for _, d := range devices {
		if d.Stub() {
			p.stubs = append(p.stubs, d)
		}
	}
	sort.Slice(p.stubs, func(a, b int) bool { return p.stubs[a].ID < p.stubs[b].ID })
	return p
}

func portMismatch(port int, want int, stub string) string {
	if port == 0 {
		return fmt.Sprintf("UniFi reports no switch port for it, and %s expects port %d", stub, want)
	}
	return fmt.Sprintf("on port %d, expected %d (%s)", port, want, stub)
}

// pick takes the stub a device binds to: the stub with its serial, else the
// oldest serial-less stub of its class whose expected port, if any, is the
// port UniFi reports. refused names a stub whose port check failed when no
// stub fits. check false skips the port check: the machine is on the intake
// port at the prep station, not on its rack port yet.
func (p *bindPass) pick(d Device, class string, port int, check bool) (*Device, string) {
	take := func(i int) *Device {
		s := p.stubs[i]
		p.stubs = append(p.stubs[:i], p.stubs[i+1:]...)
		return &s
	}
	fits := func(s Device) bool { return !check || s.ExpectedPort == 0 || s.ExpectedPort == port }
	for i, s := range p.stubs {
		if s.Serial != "" && strings.EqualFold(s.Serial, d.Serial) {
			if !fits(s) {
				return nil, portMismatch(port, s.ExpectedPort, "stub "+s.Name)
			}
			return take(i), ""
		}
	}
	if class == "" {
		return nil, ""
	}
	refused := ""
	for i, s := range p.stubs {
		if s.Serial != "" || s.Class != class {
			continue
		}
		if fits(s) {
			return take(i), ""
		}
		if refused == "" {
			refused = portMismatch(port, s.ExpectedPort, "stub "+s.Name)
		}
	}
	return nil, refused
}

// named takes the stub with the name, or nil.
func (p *bindPass) named(name string) *Device {
	for i, s := range p.stubs {
		if s.Name == name {
			p.stubs = append(p.stubs[:i], p.stubs[i+1:]...)
			return &s
		}
	}
	return nil
}

// where is the NetBox switch and port UniFi reports the MAC wired to, or
// why it cannot say.
func (r *Reconciler) where(ctx context.Context, p *bindPass, mac string) (*Switch, int, string) {
	if r.UniFi == nil {
		return nil, 0, "no UniFi is configured (FLEET_UNIFI_URL)"
	}
	if !p.stationsRead {
		p.stations, p.stationsErr = r.UniFi.Stations(ctx)
		p.stationsRead = true
		if p.stationsErr != nil {
			log.Printf("UniFi: %v", p.stationsErr)
		}
	}
	if p.stationsErr != nil {
		return nil, 0, "UniFi did not answer: " + p.stationsErr.Error()
	}
	swMAC, port, ok := Port(p.stations, mac)
	if !ok {
		return nil, 0, "UniFi does not see it wired to a switch"
	}
	if !p.switchesRead {
		p.switches, p.switchesErr = r.NetBox.Switches(ctx, r.Config.Site)
		p.switchesRead = true
	}
	if p.switchesErr != nil {
		return nil, 0, "NetBox's switches: " + p.switchesErr.Error()
	}
	for i := range p.switches {
		if p.switches[i].MACs[swMAC] {
			return &p.switches[i], port, ""
		}
	}
	return nil, 0, fmt.Sprintf("UniFi sees it on port %d of %s, which no NetBox switch has", port, swMAC)
}

// binding is what a bind decided, for its journal entry and audit line.
type binding struct {
	notes []string
}

func (b *binding) note(format string, a ...any) { b.notes = append(b.notes, fmt.Sprintf(format, a...)) }

// bind makes an attested intake a node. The device talos-attest created for
// the machine's serial, or the stub it reused, takes a stub's name and
// address, the model's class, BMC and disk, the switch port UniFi reports,
// and a free address when it has none, and then desired_action provision.
// Every step writes only what differs, so a pass that stops anywhere is
// finished by the next; the last step deletes the intake's Hardware and
// Workflows, which ends the binding.
func (r *Reconciler) bind(ctx context.Context, d Device, hw Object, in intakes, p *bindPass) error {
	wf := in.newest[hw.Name()]
	if wf == nil || !Finished(wf.State()) {
		return nil
	}
	if d.Status != "staged" || d.Verdict != "attested" {
		why := fmt.Sprintf("fleet-controller: the intake Workflow %s ended %s and the device is %s with verdict %q; it binds once it is staged and attested", wf.Name(), wf.State(), d.Status, d.Verdict)
		return r.journalOnce(ctx, fmt.Sprintf("bind-wait/%d/%s/%s", d.ID, d.Status, d.Verdict), d, "warning", why)
	}
	model, known := r.Config.Models[d.Model]
	mac := d.MAC
	if mac == "" {
		mac = hardwareMAC(hw)
	}
	sw, port, portWhy := r.where(ctx, p, mac)
	// On the intake port the machine is at the prep station: its rack port
	// is yet to come, so no port check applies and no cable follows from it.
	atIntake := port != 0 && port == r.Config.IntakePort
	check := !atIntake

	var stub *Device
	target, expected := d.Name, d.ExpectedPort
	if strings.HasPrefix(d.Name, intakeName) {
		if name, ok := strings.CutPrefix(d.Description, bindMarker); ok && name != "" {
			target = name
			stub = p.named(name)
		} else {
			class := d.Class
			if class == "" {
				class = model.Class
			}
			var refused string
			if stub, refused = p.pick(d, class, port, check); refused != "" {
				return r.refuse(ctx, d, wf.Name(), refused)
			}
			if stub != nil {
				target, expected = stub.Name, stub.ExpectedPort
			}
		}
	}
	if check && expected != 0 && expected != port {
		return r.refuse(ctx, d, wf.Name(), portMismatch(port, expected, d.Name))
	}

	var b binding
	if d.MAC == "" {
		nic, err := r.NetBox.EnsureMAC(ctx, d.ID, mac)
		if err != nil {
			return fmt.Errorf("bind MAC: %w", err)
		}
		d.MAC, d.NIC = mac, nic
		b.note("put the attested MAC %s on its interface", mac)
	}
	class := d.Class
	if stub != nil && stub.Class != "" {
		class = stub.Class
	}
	if class == "" {
		class = model.Class
	}
	bmc := d.BMCType
	if bmc == "none" && model.BMC != "" {
		bmc = model.BMC
	}
	disk := d.Disk
	if disk == "" {
		disk = model.Disk
	}
	if disk == "" {
		disk = hardwareDisk(hw)
	}
	fields := map[string]any{}
	if class != "" && class != d.Class {
		fields["talos_class"] = class
	}
	if bmc != d.BMCType {
		fields["bmc_type"] = bmc
	}
	if disk != d.Disk {
		fields["install_disk"] = disk
	}
	if expected != d.ExpectedPort {
		fields["expected_port"] = expected
	}
	if d.LastWorkflow == "" {
		fields["last_workflow"] = wf.Name()
		d.LastWorkflow = wf.Name()
	}
	patch := map[string]any{}
	if len(fields) > 0 {
		patch["custom_fields"] = fields
	}
	if target != d.Name && d.Description != bindMarker+target {
		patch["description"] = bindMarker + target
	}
	if len(patch) > 0 {
		if err := r.NetBox.Patch(ctx, d.ID, patch); err != nil {
			return fmt.Errorf("bind fields: %w", err)
		}
	}
	if !known && d.Class == "" && class == "" {
		b.note("the model %q is not in FLEET_MODEL_MAP, so it has no class", d.Model)
	}

	addr := d.Address
	if addr == "" {
		var how string
		var err error
		if addr, how, err = r.address(ctx, d, target, p); err != nil {
			return fmt.Errorf("bind address: %w", err)
		}
		b.note("%s", how)
	}

	if stub != nil {
		if err := r.NetBox.DeleteDevice(ctx, stub.ID); err != nil {
			return fmt.Errorf("delete stub %s: %w", stub.Name, err)
		}
		b.note("took over the stub %s", stub.Name)
	}
	if target != d.Name {
		if err := r.NetBox.Patch(ctx, d.ID, map[string]any{"name": target, "description": ""}); err != nil {
			return fmt.Errorf("rename to %s: %w", target, err)
		}
		b.note("renamed from %s to %s", d.Name, target)
		d.Name = target
	}

	switch {
	case atIntake && expected != 0:
		b.note("at the prep station on port %d", port)
		if err := r.cable(ctx, d, sw, expected, &b); err != nil {
			return err
		}
	case atIntake:
		b.note("at the prep station on port %d; no cable until UniFi sees it on a rack port", port)
	case sw != nil:
		if err := r.cable(ctx, d, sw, port, &b); err != nil {
			return err
		}
	default:
		if err := r.journalOnce(ctx, "bind-port/"+d.MAC, d, "warning", "fleet-controller: no switch port for the device, and no cable: "+portWhy); err != nil {
			return err
		}
	}

	d.Class, d.Address = class, addr
	if err := r.autoProvision(ctx, d, known, &b); err != nil {
		return err
	}
	summary := fmt.Sprintf("fleet-controller: bound the intake of %s (%s, serial %s) as %s, class %q, address %s", d.MAC, d.Model, d.Serial, d.Name, class, orNone(addr))
	if len(b.notes) > 0 {
		summary += "; " + strings.Join(b.notes, "; ")
	}
	if err := r.journalOnce(ctx, "bind/"+d.MAC+"/"+d.Name, d, "success", summary); err != nil {
		return err
	}
	Audit("fleet.bind", r.Config.Site, d, wf.Name(), strings.Join(append([]string{"bound"}, b.notes...), "; "))
	r.Metrics.Bound.Add(1)
	return r.dropIntake(ctx, in, hw)
}

func orNone(s string) string {
	if s == "" {
		return "none"
	}
	return s
}

// refuse journals a binding the port check stopped. Nothing is written, no
// run starts, and the next pass checks again.
func (r *Reconciler) refuse(ctx context.Context, d Device, workflow, why string) error {
	r.mu.Lock()
	seen := r.reported["bind-refused/"+d.MAC+"/"+why]
	r.mu.Unlock()
	if !seen {
		Audit("fleet.bind", r.Config.Site, d, workflow, "refused: "+why)
		Audit("fleet.autoprovision", r.Config.Site, d, workflow, "skipped: the binding was refused")
	}
	return r.journalOnce(ctx, "bind-refused/"+d.MAC+"/"+why, d, "warning", "fleet-controller: the device is not bound and not provisioned: "+why)
}

// address gives the device its primary IPv4: the address a stub reserved
// under the device's new name, else the lowest free address of the node
// prefix that no reservation, gateway or UniFi client holds.
func (r *Reconciler) address(ctx context.Context, d Device, name string, p *bindPass) (string, string, error) {
	ips, err := r.NetBox.IPsNamed(ctx, name)
	if err != nil {
		return "", "", err
	}
	for _, ip := range ips {
		if !ip.Unassigned() && !ip.On(d.NIC) {
			continue
		}
		how := "address " + stripPrefix(ip.Address) + " from the stub"
		if ip.On(d.NIC) {
			how = "address " + stripPrefix(ip.Address)
		} else if _, err := r.NetBox.AssignIP(ctx, ip.ID, "", d.NIC, name); err != nil {
			return "", "", err
		}
		if err := r.NetBox.Patch(ctx, d.ID, map[string]any{"primary_ip4": ip.ID}); err != nil {
			return "", "", err
		}
		return stripPrefix(ip.Address), how, nil
	}
	if r.Config.NodePrefix == "" {
		return "", "no address: FLEET_NODE_PREFIX is unset", nil
	}
	free, err := r.NetBox.AvailableIPs(ctx, r.Config.NodePrefix)
	if err != nil {
		return "", "", err
	}
	inUse := map[string]bool{}
	for _, s := range p.stations {
		if s.IP != "" && s.MAC != d.MAC {
			inUse[s.IP] = true
		}
	}
	for _, cidr := range free {
		a := stripPrefix(cidr)
		if !r.Config.allocatable(a) || inUse[a] || p.allocatedAddrs[a] {
			continue
		}
		id, err := r.NetBox.AssignIP(ctx, 0, cidr, d.NIC, name)
		if err != nil {
			return "", "", err
		}
		p.allocatedAddrs[a] = true
		if err := r.NetBox.Patch(ctx, d.ID, map[string]any{"primary_ip4": id}); err != nil {
			return "", "", err
		}
		return a, "address " + a + " allocated from " + r.Config.NodePrefix, nil
	}
	return "", "no address: " + r.Config.NodePrefix + " has no free address", nil
}

// allocatable says whether an address of the node prefix may go to a new
// node: inside the prefix, neither its network nor its broadcast address,
// and not reserved.
func (c Config) allocatable(a string) bool {
	pfx, err := netip.ParsePrefix(c.NodePrefix)
	if err != nil {
		return false
	}
	addr, err := netip.ParseAddr(a)
	if err != nil || !pfx.Contains(addr) || c.NodeReserved[a] {
		return false
	}
	if !addr.Is4() || pfx.Bits() > 30 {
		return pfx.Bits() > 30
	}
	base := pfx.Masked().Addr().As4()
	first := uint32(base[0])<<24 | uint32(base[1])<<16 | uint32(base[2])<<8 | uint32(base[3])
	last := first + 1<<(32-pfx.Bits()) - 1
	a4 := addr.As4()
	n := uint32(a4[0])<<24 | uint32(a4[1])<<16 | uint32(a4[2])<<8 | uint32(a4[3])
	return n != first && n != last
}

// cable runs the device's cable to the switch port UniFi reports.
func (r *Reconciler) cable(ctx context.Context, d Device, sw *Switch, port int, b *binding) error {
	swPort, err := r.NetBox.SwitchPort(ctx, sw.ID, port)
	if err != nil {
		return fmt.Errorf("switch port: %w", err)
	}
	if swPort == 0 {
		return r.journalOnce(ctx, "bind-noport/"+d.MAC, d, "warning", fmt.Sprintf("fleet-controller: UniFi sees the device on port %d of %s, which NetBox lacks; no cable", port, sw.Name))
	}
	made, replaced, err := r.NetBox.Cable(ctx, d.NIC, swPort)
	if err != nil {
		return fmt.Errorf("cable: %w", err)
	}
	if made {
		b.note("cabled to %s Port %d", sw.Name, port)
	}
	if len(replaced) > 0 {
		b.note("replaced the cable %s", strings.Join(replaced, ", "))
	}
	return nil
}

// autoProvision sets desired_action provision once on a bound device with a
// class and an address, when FLEET_AUTO_PROVISION allows it.
func (r *Reconciler) autoProvision(ctx context.Context, d Device, known bool, b *binding) error {
	why := ""
	switch {
	case d.DesiredAction != "none":
		return nil
	case !d.FromIntake():
		why = fmt.Sprintf("its last run is %s, not its intake", d.LastWorkflow)
	case !r.Config.AutoProvision:
		why = "FLEET_AUTO_PROVISION is off"
	case d.Class == "" && !known:
		why = fmt.Sprintf("the model %q is not in FLEET_MODEL_MAP and no stub gave a class", d.Model)
	case d.Class == "":
		why = "the device has no class"
	case d.Address == "":
		why = "the device has no address"
	}
	if why != "" {
		b.note("no auto-provision: %s", why)
		Audit("fleet.autoprovision", r.Config.Site, d, d.LastWorkflow, "skipped: "+why)
		return nil
	}
	if err := r.NetBox.Patch(ctx, d.ID, map[string]any{"custom_fields": map[string]any{"desired_action": "provision"}}); err != nil {
		return fmt.Errorf("auto-provision: %w", err)
	}
	b.note("desired_action is provision")
	r.Metrics.AutoProvisioned.Add(1)
	Audit("fleet.autoprovision", r.Config.Site, d, d.LastWorkflow, "provision")
	return nil
}
