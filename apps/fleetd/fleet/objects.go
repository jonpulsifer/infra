package fleet

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

// Labels on every Workflow: the device and the action.
const (
	NodeLabel   = "lolwtf.ca/node"
	ActionLabel = "lolwtf.ca/action"
)

// ActionRetire is the Workflow the fleet runs for a decommissioning
// device. It is no desired_action: the status asks for it.
const ActionRetire = "retire"

// Action says what one run asks the provision Template to do, and the NetBox
// status an active or failed device takes while it runs (NextStatus). Every
// run netboots HookOS, which attests on every boot, so an attest is a run
// that does nothing else. It leaves an active node active: planned would
// take it out of the Talos root, which applies no config to a node until it
// is active. Attest makes the run's wipe wait for that boot's pass.
type Action struct {
	Attest, Wipe, Retire bool
	Status               string
}

// Actions are the runs the fleet starts, by desired_action and by
// ActionRetire.
var Actions = map[string]Action{
	"provision":  {Attest: true, Wipe: true, Status: "planned"},
	"attest":     {Attest: true},
	"wipe":       {Wipe: true, Status: "planned"},
	ActionRetire: {Wipe: true, Retire: true},
}

// Installing says whether a planned device has passed attestation: its
// first install, or a reinstall after a provision or wipe moved it back to
// planned. It stays planned until its node fetches its config.
func (d Device) Installing() bool { return d.Status == "planned" && passedVerdict(d.Verdict) }

// passedVerdict says whether an attest_verdict is a pass, as the verifier reads
// it: attested, or a control plane's failed check that left it in place.
func passedVerdict(verdict string) bool {
	return verdict == "attested" || strings.HasPrefix(verdict, "failed-no-quarantine")
}

// HasBMC says whether the device gets a Machine now: a BMC type and an
// address for it, which for AMT is the device's own declared address, from
// the moment it has one, a planned device's included.
func (d Device) HasBMC() bool {
	return d.BMCType != "" && d.BMCType != "none" && d.BMCAddress != ""
}

// ManualBoot says whether Rufio stays out of a run: a device without a
// Machine.
func (d Device) ManualBoot() bool {
	return !d.HasBMC()
}

func labels(d Device, extra map[string]string) map[string]any {
	l := map[string]any{ManagedLabel: FieldManager, NodeLabel: d.Name}
	for k, v := range extra {
		l[k] = v
	}
	return l
}

// Hardware is the device's Tinkerbell Hardware: its MAC, install disk and the
// iPXE script that chains the signed HookOS UKI. The fleet owns both
// netboot flags: allowPXE and allowWorkflow are netboot, true while the device
// has an unfinished Workflow and false otherwise. The interfaces list is
// atomic, so each apply replaces what another writer set there, a hand-set
// allowPXE included, and an apply that left a flag out would unset it. The
// script frees every iPXE image before the chain, because iPXE claims the
// Linux initrd device whenever another image is loaded, and systemd-stub then
// fails to register the UKI's initrd.
func (c Config) Hardware(d Device, netboot bool) Object {
	spec := map[string]any{
		"disks": []any{map[string]any{"device": d.Disk}},
		"interfaces": []any{map[string]any{
			"dhcp": map[string]any{
				"mac":      d.MAC,
				"hostname": d.Name,
				"arch":     "x86_64",
				"uefi":     true,
			},
			"netboot": map[string]any{
				"allowPXE":      netboot,
				"allowWorkflow": netboot,
				"ipxe": map[string]any{
					"contents": fmt.Sprintf("#!ipxe\nimgfree\nchain --autofree %s %s\n", c.HookOSURL, c.HookOSCmdline),
				},
			},
		}},
	}
	if d.HasBMC() {
		spec["bmcRef"] = map[string]any{"apiGroup": "bmc.tinkerbell.org", "kind": "Machine", "name": d.Name}
	}
	return Object{
		"apiVersion": HardwareResource.apiVersion(),
		"kind":       HardwareResource.Kind,
		"metadata":   map[string]any{"name": d.Name, "labels": labels(d, nil)},
		"spec":       spec,
	}
}

// Machine is the device's Rufio Machine. AMT speaks plain HTTP digest auth
// on 16992, because its TLS offers only RSA key exchange, which Go refuses.
func (c Config) Machine(d Device) (Object, error) {
	secret, ok := c.BMCSecrets[d.BMCType]
	if !ok {
		return nil, fmt.Errorf("no Secret is configured for bmc_type %q", d.BMCType)
	}
	conn := map[string]any{
		"host":          d.BMCAddress,
		"insecureTLS":   false,
		"authSecretRef": map[string]any{"name": secret, "namespace": c.Namespace},
	}
	switch d.BMCType {
	case "amt":
		conn["providerOptions"] = map[string]any{
			"preferredOrder": []any{"IntelAMT"},
			"intelAMT":       map[string]any{"hostScheme": "http", "port": c.AMTPort},
		}
	default:
		return nil, fmt.Errorf("bmc_type %q has no Rufio provider here", d.BMCType)
	}
	return Object{
		"apiVersion": MachineResource.apiVersion(),
		"kind":       MachineResource.Kind,
		"metadata":   map[string]any{"name": d.Name, "labels": labels(d, nil)},
		"spec":       map[string]any{"connection": conn},
	}, nil
}

// WorkflowName is <action>-<node>-<unix seconds>: unique per run, so a rerun
// never reads an old Rufio job.
func WorkflowName(action, node string, now time.Time) string {
	return fmt.Sprintf("%s-%s-%d", action, node, now.Unix())
}

func isRetireWorkflow(name, node string) bool {
	return strings.HasPrefix(name, ActionRetire+"-"+node+"-")
}

// SkipsAttest says whether a device has no TPM 2.0 to attest with: an
// explicit TPM 1.2, or the worker-g2 class, which is one. An unset version is
// not a reason to skip.
func SkipsAttest(d Device) bool {
	return d.TPM == "1.2" || d.Class == "worker-g2"
}

// Installer is the Talos installer image a provision of the device runs
// from HookOS, or "" when the run installs nothing. Only a device that
// attests installs: its intake pass is where the machine gets the code its
// first boot fetches the config with. Installs holds only the classes the
// controller renders, so a control plane without the secrets bundle, or a
// fleet without a renderer, leaves the install to the owner. As the render
// does, it refuses the control plane at Bootstrap, which the Talos root
// bootstraps, and a control plane with no address: an install the render
// then refuses would leave a node with no config.
func (c Config) Installer(d Device, action string) string {
	if action != "provision" || SkipsAttest(d) {
		return ""
	}
	if c.Bootstrap != "" && d.Address == c.Bootstrap {
		return ""
	}
	if c.IsControlPlane(d.Class) && d.Address == "" {
		return ""
	}
	return c.Installs[d.Class]
}

// ControlPlaneClass is the control plane's Talos class: NetBox's talos_class
// choice, the model map's and the class inputs' key.
const ControlPlaneClass = "controlplane"

// IsControlPlane says whether a class is a control plane's: ControlPlaneClass,
// or a class the class inputs render as one.
func (c Config) IsControlPlane(class string) bool {
	return class == ControlPlaneClass || c.ControlPlaneClasses[class]
}

// Workflow runs the provision Template for one action. A device that boots
// by hand (ManualBoot), or one whose machine already waits in HookOS
// (hookos), gets no boot mode.
// toggleAllowNetboot is off: the fleet sets the Hardware's flags before the
// Workflow exists, and Tinkerbell's toggle would be a second writer of the
// same atomic list, racing the fleet's apply.
func (c Config) Workflow(d Device, action string, now time.Time, hookos bool) Object {
	a := Actions[action]
	installer := c.Installer(d, action)
	spec := map[string]any{
		"templateRef": c.Template,
		"hardwareRef": d.Name,
		"hardwareMap": map[string]any{
			"attest":          fmt.Sprint(a.Attest && !SkipsAttest(d)),
			"wipe":            fmt.Sprint(a.Wipe),
			"retire":          fmt.Sprint(a.Retire),
			"install":         fmt.Sprint(installer != ""),
			"installer_image": installer,
		},
	}
	boot := map[string]any{"toggleAllowNetboot": false}
	if !hookos && !d.ManualBoot() {
		boot["bootMode"] = "netboot"
	}
	spec["bootOptions"] = boot
	meta := map[string]any{
		"name":   WorkflowName(action, d.Name, now),
		"labels": labels(d, map[string]string{ActionLabel: action}),
	}
	return Object{
		"apiVersion": WorkflowResource.apiVersion(),
		"kind":       WorkflowResource.Kind,
		"metadata":   meta,
		"spec":       spec,
	}
}

// NextStatus is the NetBox status a device takes when an action starts, or
// "" to leave it. A provision or wipe moves an active or failed device back
// to planned, which the Talos root applies no config to, until its node
// fetches its config. A planned device stays planned.
func NextStatus(action, current string) string {
	next := Actions[action].Status
	if next == "" || next == current {
		return ""
	}
	switch current {
	case "active", "failed":
		return next
	}
	return ""
}

// Finished says whether a Workflow state is terminal.
func Finished(state string) bool {
	switch strings.TrimPrefix(state, "STATE_") {
	case "SUCCESS", "FAILED", "TIMEOUT":
		return true
	}
	return false
}

// Unfinished says whether any of the Workflows has not reached a terminal
// state. One Tinkerbell has not picked up yet has no state, and counts.
func Unfinished(workflows []Object) bool {
	for _, wf := range workflows {
		if !Finished(wf.State()) {
			return true
		}
	}
	return false
}

// Succeeded says whether a Workflow state is the success.
func Succeeded(state string) bool { return strings.TrimPrefix(state, "STATE_") == "SUCCESS" }

func sortByCreatedDesc(objs []Object) {
	sort.SliceStable(objs, func(a, b int) bool { return objs[a].Created().After(objs[b].Created()) })
}
