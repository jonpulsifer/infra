package main

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

// ActionRetire is the Workflow the controller runs for a decommissioning
// device. It is no desired_action: the status asks for it.
const ActionRetire = "retire"

// Action says what one run asks the provision Template to do, and the NetBox
// status an active or failed device takes while it runs (NextStatus). An
// attest leaves an active node active: staged would mark it enrolling in the
// Talos root and re-arm the enrollment server's auto-approval.
type Action struct {
	Attest, Wipe, Retire bool
	Status               string
}

// Actions are the runs the controller starts, by desired_action and by
// ActionRetire.
var Actions = map[string]Action{
	"provision":  {Attest: true, Wipe: true, Status: "staged"},
	"attest":     {Attest: true},
	"wipe":       {Wipe: true, Status: "staged"},
	ActionRetire: {Wipe: true, Retire: true},
}

// HasBMC says whether the device gets a Machine now. A planned device has no
// RADIUS user yet, so it and its AMT sit on the bootstrap fallback with a
// lease there, and an AMT address derived from the Kubernetes address it
// does not hold yet is wrong; only an explicit oob_ip counts until the status
// leaves planned. A device fresh from its intake is in the same place: its
// export has not been applied, and its agent waits in HookOS.
func (d Device) HasBMC() bool {
	if d.BMCType == "none" || d.BMCAddress == "" {
		return false
	}
	return d.Status != "planned" && !d.FromIntake() || d.OOBAddress != ""
}

// ManualBoot says whether Rufio stays out of a run: a device without a
// Machine, any planned device, whose BMC Rufio cannot reach at a Kubernetes
// address it does not hold yet, and a device fresh from its intake, which
// is already in HookOS.
func (d Device) ManualBoot() bool {
	return d.Status == "planned" || d.FromIntake() || !d.HasBMC()
}

func labels(d Device, extra map[string]string) map[string]any {
	l := map[string]any{ManagedLabel: FieldManager, NodeLabel: d.Name}
	for k, v := range extra {
		l[k] = v
	}
	return l
}

// Hardware is the device's Tinkerbell Hardware: its MAC, install disk and the
// iPXE script that chains the signed HookOS UKI. The controller owns both
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
// Redfish is a BMC of its own at oob_ip.
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
	case "redfish":
		conn["insecureTLS"] = c.RedfishInsecure
		conn["providerOptions"] = map[string]any{
			"preferredOrder": []any{"gofish"},
			"redfish":        map[string]any{"port": c.RedfishPort, "useBasicAuth": true},
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
// from HookOS, or "" when the run installs nothing. Only a provision that
// attests installs: the attest step is where the machine gets the code its
// first boot fetches the config with. Installs holds only the classes the
// controller renders, so a control plane, or a controller without a
// renderer, leaves the install to the old path.
func (c Config) Installer(d Device, action string) string {
	if action != "provision" || SkipsAttest(d) {
		return ""
	}
	return c.Installs[d.Class]
}

// Workflow runs the provision Template for one action. A device that boots
// by hand (ManualBoot) gets no boot mode, and somebody powers the machine on.
// toggleAllowNetboot is off: the controller sets the Hardware's flags before
// the Workflow exists, and Tinkerbell's toggle would be a second writer of the
// same atomic list, racing the controller's apply.
func (c Config) Workflow(d Device, action string, now time.Time) Object {
	a := Actions[action]
	attest := a.Attest && !SkipsAttest(d)
	installer := c.Installer(d, action)
	spec := map[string]any{
		"templateRef": c.Template,
		"hardwareRef": d.Name,
		"hardwareMap": map[string]any{
			"wipe":            fmt.Sprint(a.Wipe),
			"attest":          fmt.Sprint(attest),
			"retire":          fmt.Sprint(a.Retire),
			"install":         fmt.Sprint(installer != ""),
			"installer_image": installer,
			"attest_url":      c.AttestURL,
			"ntp_server":      c.NTPServer,
		},
	}
	boot := map[string]any{"toggleAllowNetboot": false}
	if !d.ManualBoot() {
		boot["bootMode"] = "netboot"
	}
	spec["bootOptions"] = boot
	return Object{
		"apiVersion": WorkflowResource.apiVersion(),
		"kind":       WorkflowResource.Kind,
		"metadata": map[string]any{
			"name":   WorkflowName(action, d.Name, now),
			"labels": labels(d, map[string]string{ActionLabel: action}),
		},
		"spec": spec,
	}
}

// NextStatus is the NetBox status a device takes when an action starts, or
// "" to leave it. A provision or wipe marks an active or failed device
// staged. A planned device stays planned: talos-attest grants a first intake
// the no-click pass only while the device is planned, and moves it to staged
// itself on the verdict.
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
