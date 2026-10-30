package fleet

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"sort"
	"strings"
	"time"
)

// Model is what the model map says of one SMBIOS model: the class, BMC,
// install disk and hardware facts an admitted device of that model gets when
// it has none. TPM is the spec version the model carries; a render of its
// class waits for the device to record it.
type Model struct {
	Class      string `json:"class"`
	BMC        string `json:"bmc"`
	Disk       string `json:"disk"`
	TPM        string `json:"tpm"`
	AMT        bool   `json:"amt"`
	SecureBoot bool   `json:"secure_boot"`
}

// DefaultModels is FLEET_MODEL_MAP when the environment sets none.
var DefaultModels = map[string]Model{
	"HP EliteDesk 800 G5 Desktop Mini": {Class: "worker-g5", BMC: "amt", Disk: "/dev/nvme0n1", TPM: "2.0", AMT: true, SecureBoot: true},
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

// passCache is one pass's reads that more than one device may need: NetBox's
// switches, read once and only when a device needs them, and the addresses
// the pass has handed out.
type passCache struct {
	switches       []Switch
	switchesErr    error
	switchesRead   bool
	allocatedAddrs map[string]bool
}

func newPassCache() *passCache { return &passCache{allocatedAddrs: map[string]bool{}} }

func portMismatch(port int, want int, name string) string {
	if port == 0 {
		return fmt.Sprintf("its intake pass attested no switch port, and %s expects port %d", name, want)
	}
	return fmt.Sprintf("on port %d, expected %d (%s)", port, want, name)
}

// where is the switch port the device's attested LLDP neighbour names, from
// a pass at or after since: the NetBox switch whose MAC is the chassis ID and
// the port number, or why it cannot say. Only facts the session's AK signed
// count.
func (r *Reconciler) where(ctx context.Context, p *passCache, d Device, since time.Time) (*Switch, int, string) {
	a := d.Attested
	switch {
	case a.At.IsZero() || a.Switch == "" || a.Port == "":
		return nil, 0, "the verifier recorded no attested switch port"
	case a.At.Before(since):
		return nil, 0, fmt.Sprintf("the attested switch port is from %s, before %s", a.At.UTC().Format(time.RFC3339), since.UTC().Format(time.RFC3339))
	}
	port, ok := portNumber(a.Port)
	if !ok {
		return nil, 0, fmt.Sprintf("the attested port %s of %s is no Port <n>", plain(a.Port), plain(a.Switch))
	}
	if !p.switchesRead {
		p.switches, p.switchesErr = r.NetBox.Switches(ctx, r.Config.Site)
		p.switchesRead = true
	}
	if p.switchesErr != nil {
		return nil, 0, "NetBox's switches: " + p.switchesErr.Error()
	}
	for i := range p.switches {
		if p.switches[i].MACs[a.Switch] {
			return &p.switches[i], port, ""
		}
	}
	return nil, 0, fmt.Sprintf("the attested port %d is on %s, which no NetBox switch has", port, plain(a.Switch))
}

// binding is what a bind decided, for its journal entry and audit line.
type binding struct {
	notes []string
}

func (b *binding) note(format string, a ...any) { b.notes = append(b.notes, fmt.Sprintf(format, a...)) }

// Admit is an intake pass's install, called by the verifier after the pass's
// signed confirm and before it answers the install code. It binds the
// planned device, starts its provision when one is asked for or allowed, and
// renders its config under the code. Only nil means the config waits for the
// code; the pass stands either way. Admit and a reconcile pass never run at
// once, so one Workflow starts for the device. A new run starts only once
// the render's gates pass, so no run wipes a disk it cannot install.
func (r *Reconciler) Admit(ctx context.Context, req RenderRequest) error {
	if r.Installer == nil {
		return unavailable("the fleet has no installer")
	}
	if err := r.lock(ctx); err != nil {
		return unavailable("waiting for the reconcile pass: %v", err)
	}
	defer r.unlock()
	d, err := r.NetBox.BySerial(ctx, r.Config.Site, req.Serial)
	if errors.Is(err, ErrNoDevice) {
		return conflict("NetBox has no %s node with that serial", r.Config.Site)
	}
	if err != nil {
		return unavailable("NetBox: %v", err)
	}
	if d.Status != "planned" {
		return conflict("%s is %s; only a planned device installs", d.Name, d.Status)
	}
	if d, err = r.bind(ctx, d, newPassCache()); err != nil {
		return err
	}
	if !r.provisionRunning(ctx, d) {
		if why := r.provisionWhy(d); why != "" {
			Audit("fleet.autoprovision", r.Config.Site, d, d.LastWorkflow, "skipped: "+why)
			return conflict("no provision: %s", why)
		}
		if d.MAC == "" || d.Disk == "" {
			return conflict("%s needs a primary MAC on an interface and install_disk", d.Name)
		}
		if r.Config.Installer(d, "provision") != "" {
			if err := r.Installer.Ready(ctx, d); err != nil {
				return err
			}
		}
		workflows, err := r.nodeWorkflows(ctx, d)
		if err != nil {
			return unavailable("%v", err)
		}
		name, err := r.start(ctx, d, "provision", workflows, true)
		if err != nil {
			return unavailable("%v", err)
		}
		if d.DesiredAction != "provision" {
			r.Metrics.AutoProvisioned.Add(1)
			Audit("fleet.autoprovision", r.Config.Site, d, name, "provision")
		}
	}
	return r.Installer.Render(ctx, req)
}

// provisionRunning says whether the device's last_workflow is a provision
// that has not finished, such as the run that netbooted it.
func (r *Reconciler) provisionRunning(ctx context.Context, d Device) bool {
	if !strings.HasPrefix(d.LastWorkflow, "provision-"+d.Name+"-") {
		return false
	}
	wf, err := r.Kube.Get(ctx, WorkflowResource, d.LastWorkflow)
	return err == nil && !Finished(wf.State())
}

// provisionWhy says why an admitted device starts no provision, or "" when
// it starts one: the owner asked for it, or the device never ran a Workflow
// and FLEET_AUTO_PROVISION lets a worker with a class and an address go. A
// control plane never provisions on its own: its install hands it the
// cluster's CA keys, so the owner sets desired_action by hand.
func (r *Reconciler) provisionWhy(d Device) string {
	switch {
	case d.DesiredAction == "provision":
		return ""
	case d.DesiredAction != "none":
		return fmt.Sprintf("desired_action is %s", d.DesiredAction)
	case d.LastWorkflow != "":
		return fmt.Sprintf("its last run is %s; the owner sets desired_action to provision", d.LastWorkflow)
	case !r.Config.AutoProvision:
		return "FLEET_AUTO_PROVISION is off"
	case d.Class == "":
		return "the device has no class"
	case r.Config.IsControlPlane(d.Class):
		return "a control plane; the owner sets desired_action to provision by hand"
	case d.Address == "":
		return "the device has no address"
	case r.Config.Installer(d, "provision") == "":
		return "its class installs nothing here; the owner sets desired_action to provision"
	}
	return ""
}

// bind fills in what an admitted device lacks: the model's class, BMC and
// disk, its amt and secure_boot_expected when they are empty, an address,
// and a cable to the switch port its intake pass attested. A device whose
// expected_port is not that port is refused: nothing is written and the
// journal says why. Every step writes only what differs.
func (r *Reconciler) bind(ctx context.Context, d Device, p *passCache) (Device, error) {
	model, known := r.Config.Models[d.Model]
	sw, port, portWhy := r.where(ctx, p, d, r.Now().Add(-AttestedPortTTL))
	if d.ExpectedPort != 0 && d.ExpectedPort != port {
		why := portMismatch(port, d.ExpectedPort, d.Name)
		Audit("fleet.bind", r.Config.Site, d, d.LastWorkflow, "refused: "+why)
		if err := r.journalOnce(ctx, "bind-refused/"+d.MAC+"/"+why, d, "warning", "fleetd: the device is not provisioned: "+why); err != nil {
			return d, unavailable("journal: %v", err)
		}
		return d, conflict("%s", why)
	}

	var b binding
	class := d.Class
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
	fields := map[string]any{}
	if class != d.Class {
		fields["talos_class"] = class
	}
	if bmc != d.BMCType {
		fields["bmc_type"] = bmc
	}
	if disk != d.Disk {
		fields["install_disk"] = disk
	}
	if known && d.AMT == nil {
		fields["amt"] = model.AMT
	}
	if known && d.SecureBootExpected == nil {
		fields["secure_boot_expected"] = model.SecureBoot
	}
	if len(fields) > 0 {
		if err := r.NetBox.Patch(ctx, d.ID, map[string]any{"custom_fields": fields}); err != nil {
			return d, unavailable("bind fields: %v", err)
		}
		b.note("filled %s from the model map", strings.Join(sortedKeys(fields), ", "))
	}
	if !known && class == "" {
		b.note("the model %q is not in FLEET_MODEL_MAP, so it has no class", d.Model)
	}
	d.Class, d.BMCType, d.Disk = class, bmc, disk

	if d.Address == "" {
		addr, how, err := r.address(ctx, d, d.Name, p)
		if err != nil {
			return d, unavailable("bind address: %v", err)
		}
		d.Address = addr
		b.note("%s", how)
	}

	switch {
	case sw != nil && !d.Cabled:
		if _, err := r.cable(ctx, d, sw, port, &b); err != nil {
			return d, unavailable("%v", err)
		}
	case sw == nil:
		if err := r.journalOnce(ctx, "bind-port/"+d.MAC, d, "warning", "fleetd: no switch port for the device, and no cable: "+portWhy); err != nil {
			return d, unavailable("journal: %v", err)
		}
	}
	if len(b.notes) == 0 {
		return d, nil
	}
	summary := fmt.Sprintf("fleetd: admitted %s (%s, serial %s), class %q, address %s; %s", d.Name, d.Model, d.Serial, d.Class, orNone(d.Address), strings.Join(b.notes, "; "))
	if err := r.journalOnce(ctx, "bind/"+d.MAC+"/"+d.Name+"/"+strings.Join(b.notes, ";"), d, "success", summary); err != nil {
		return d, unavailable("journal: %v", err)
	}
	Audit("fleet.bind", r.Config.Site, d, d.LastWorkflow, strings.Join(append([]string{"bound"}, b.notes...), "; "))
	r.Metrics.Bound.Add(1)
	return d, nil
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func orNone(s string) string {
	if s == "" {
		return "none"
	}
	return s
}

// address gives the device its primary IPv4: the address NetBox reserves
// under the device's name, else the lowest free address of the node prefix
// that no reservation or gateway holds.
func (r *Reconciler) address(ctx context.Context, d Device, name string, p *passCache) (string, string, error) {
	ips, err := r.NetBox.IPsNamed(ctx, name)
	if err != nil {
		return "", "", err
	}
	for _, ip := range ips {
		if !ip.Unassigned() && !ip.On(d.NIC) {
			continue
		}
		how := "address " + stripPrefix(ip.Address) + " from its reservation"
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
	for _, cidr := range free {
		a := stripPrefix(cidr)
		if !r.Config.allocatable(a) || p.allocatedAddrs[a] {
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
// not reserved, and outside the DHCP pool, whose leases would collide with a
// static address.
func (c Config) allocatable(a string) bool {
	pfx, err := netip.ParsePrefix(c.NodePrefix)
	if err != nil {
		return false
	}
	addr, err := netip.ParseAddr(a)
	if err != nil || !pfx.Contains(addr) || c.NodeReserved[a] || c.NodeDHCP.IsValid() && c.NodeDHCP.Contains(addr) {
		return false
	}
	return hostAddress(pfx, addr)
}

// hostAddress says whether an address of the prefix is neither its network
// nor its broadcast address. A prefix longer than /30 has neither.
func hostAddress(pfx netip.Prefix, addr netip.Addr) bool {
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

// cable runs the device's cable to the attested switch port, and says
// whether it made one. It never takes a port another device's cable holds:
// NetBox's cable stays, and the conflict is journaled for the owner.
func (r *Reconciler) cable(ctx context.Context, d Device, sw *Switch, port int, b *binding) (bool, error) {
	swPort, err := r.NetBox.SwitchPort(ctx, sw.ID, port)
	if err != nil {
		return false, fmt.Errorf("switch port: %w", err)
	}
	if swPort == 0 {
		return false, r.journalOnce(ctx, "bind-noport/"+d.MAC, d, "warning", fmt.Sprintf("fleetd: the device is on port %d of %s, which NetBox lacks; no cable", port, sw.Name))
	}
	made, replaced, err := r.NetBox.Cable(ctx, d.NIC, swPort, false)
	if errors.Is(err, ErrPortTaken) {
		b.note("no cable: %s Port %d has another", sw.Name, port)
		return false, r.journalOnce(ctx, fmt.Sprintf("bind-taken/%s/%d", d.MAC, port), d, "warning", fmt.Sprintf("fleetd: %s Port %d, the device's port, is cabled to another device in NetBox; no cable, and the other cable stays", sw.Name, port))
	}
	if err != nil {
		return false, fmt.Errorf("cable: %w", err)
	}
	if made {
		b.note("cabled to %s Port %d", sw.Name, port)
	}
	if len(replaced) > 0 {
		b.note("replaced the cable %s", strings.Join(replaced, ", "))
	}
	return made, nil
}
