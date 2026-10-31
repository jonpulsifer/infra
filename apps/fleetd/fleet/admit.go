package fleet

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"
)

func portMismatch(port int, want int, name string) string {
	if port == 0 {
		return fmt.Sprintf("its intake pass attested no switch port, and %s expects port %d", name, want)
	}
	return fmt.Sprintf("on port %d, expected %d (%s)", port, want, name)
}

// where is the switch port the device's attested LLDP neighbour names, from
// a pass at or after since, or why it cannot say. The neighbour must be a
// NetBox switch, found by its chassis ID. Only facts the session's AK signed
// count.
func (r *Reconciler) where(ctx context.Context, d Device, since time.Time) (int, string) {
	a := d.Attested
	switch {
	case a.At.IsZero() || a.Switch == "" || a.Port == "":
		return 0, "the verifier recorded no attested switch port"
	case a.At.Before(since):
		return 0, fmt.Sprintf("the attested switch port is from %s, before %s", a.At.UTC().Format(time.RFC3339), since.UTC().Format(time.RFC3339))
	}
	port, ok := portNumber(a.Port)
	if !ok {
		return 0, fmt.Sprintf("the attested port %s of %s is no Port <n>", plain(a.Port), plain(a.Switch))
	}
	switches, err := r.NetBox.Switches(ctx, r.Config.Site)
	if err != nil {
		return 0, "NetBox's switches: " + err.Error()
	}
	for _, sw := range switches {
		if sw.MACs[a.Switch] {
			return port, ""
		}
	}
	return 0, fmt.Sprintf("the attested port %d is on %s, which no NetBox switch has", port, plain(a.Switch))
}

// Admit is an intake pass's install, called by the verifier after the pass's
// signed confirm and before it answers the install code. It checks the
// planned device against its declaration, starts its provision when one is asked for or allowed, and
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
	if err := r.checkDeclared(ctx, d); err != nil {
		return err
	}
	if !r.provisionRunning(ctx, d) {
		if why := r.provisionWhy(d); why != "" {
			Audit("fleet.autoprovision", r.Config.Site, d, d.LastWorkflow, "skipped: "+why)
			if err := r.hookosAfterSuccess(ctx, d, req.UUID); err != nil {
				log.Printf("fleet.hookos-after-success: %s: %v", d.Name, err)
			}
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
		if !strings.HasPrefix(name, "provision-"+d.Name+"-") {
			return conflict("Workflow %s, which is no provision, is still running", name)
		}
		if d.DesiredAction != "provision" {
			r.Metrics.AutoProvisioned.Add(1)
			Audit("fleet.autoprovision", r.Config.Site, d, name, "provision")
		}
	}
	return r.Installer.Render(ctx, req)
}

// hookosAfterSuccess journals once per run that a planned device attested
// from HookOS after its provision Workflow succeeded and before its node read
// its config: the firmware did not boot the installed disk. A device with a
// desired_action set is on its way to a run that netboots on purpose, and is
// no failure. The Workflow's annotation keeps the journal once across a
// restart.
func (r *Reconciler) hookosAfterSuccess(ctx context.Context, d Device, uuid string) error {
	if d.DesiredAction != "none" || !strings.HasPrefix(d.LastWorkflow, "provision-"+d.Name+"-") {
		return nil
	}
	if _, unread := r.Installer.Configs.Holds(uuid); !unread {
		return nil
	}
	wf, err := r.Kube.Get(ctx, WorkflowResource, d.LastWorkflow)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if strings.TrimPrefix(wf.State(), "STATE_") != "SUCCESS" {
		return nil
	}
	if _, done := wf.Annotations()[HookOSAfterAnnotation]; done {
		return nil
	}
	why := fmt.Sprintf("fleetd: the node booted HookOS and attested after Workflow %s succeeded, so its firmware did not boot the installed disk. Check its boot order (PXE first sends it back to HookOS) and its console, then fix the order or set desired_action to provision to run it again", wf.Name())
	if err := r.journalOnce(ctx, "hookos-after/"+wf.Name(), d, "warning", why); err != nil {
		return err
	}
	err = r.Kube.Annotate(ctx, WorkflowResource, wf.Name(), map[string]string{HookOSAfterAnnotation: r.Now().UTC().Format(time.RFC3339)})
	if err != nil && !errors.Is(err, ErrNotFound) {
		return fmt.Errorf("annotate %s: %w", wf.Name(), err)
	}
	r.Metrics.HookOSAfter.Add(1)
	Audit("fleet.workflow", r.Config.Site, d, wf.Name(), "node booted HookOS after SUCCESS")
	return nil
}

// Expected says whether fleetd expects the machine with the serial in
// HookOS: its device is planned, or its last run has not finished. A serial
// NetBox does not hold is not expected; a failed lookup is an error.
func (r *Reconciler) Expected(ctx context.Context, serial string) (bool, error) {
	d, err := r.NetBox.BySerial(ctx, r.Config.Site, serial)
	if errors.Is(err, ErrNoDevice) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if d.Status == "planned" {
		return true, nil
	}
	if d.LastWorkflow == "" {
		return false, nil
	}
	wf, err := r.Kube.Get(ctx, WorkflowResource, d.LastWorkflow)
	if errors.Is(err, ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return !Finished(wf.State()), nil
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
// and FLEET_AUTO_PROVISION lets a worker go. A
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
	case r.Config.IsControlPlane(d.Class):
		return "a control plane; the owner sets desired_action to provision by hand"
	case r.Config.Installer(d, "provision") == "":
		return "its class installs nothing here; the owner sets desired_action to provision"
	}
	return ""
}

// missing names the declared fields a planned device lacks. Terraform
// applies them from the nodes file, so an empty one is an apply that has not
// run, and the owner fixes it there.
func (d Device) missing() []string {
	var m []string
	for _, f := range []struct {
		name string
		ok   bool
	}{
		{"talos_class", d.Class != ""},
		{"install_disk", d.Disk != ""},
		{"install_disk_serial", d.DiskSerial != ""},
		{"bmc_type", d.BMCType != ""},
		{"tpm_version", d.TPM != ""},
		{"amt", d.AMT != nil},
		{"secure_boot_expected", d.SecureBootExpected != nil},
		{"expected_port", d.ExpectedPort != 0},
		{"primary_ip4", d.Address != ""},
	} {
		if !f.ok {
			m = append(m, f.name)
		}
	}
	return m
}

// checkDeclared refuses a device that git's declaration does not fully
// describe in NetBox, or whose intake pass attested a switch port other than
// its expected_port. It writes the journal and nothing else.
func (r *Reconciler) checkDeclared(ctx context.Context, d Device) error {
	why := ""
	if m := d.missing(); len(m) > 0 {
		why = fmt.Sprintf("%s lacks %s; apply terraform/netbox/folly", d.Name, strings.Join(m, ", "))
	} else if _, ok := r.Config.Classes[d.Class]; !ok {
		why = fmt.Sprintf("%s's class %q is not in the class table", d.Name, d.Class)
	} else if port, _ := r.where(ctx, d, r.Now().Add(-AttestedPortTTL)); d.ExpectedPort != port {
		why = portMismatch(port, d.ExpectedPort, d.Name)
	}
	if why == "" {
		return nil
	}
	Audit("fleet.bind", r.Config.Site, d, d.LastWorkflow, "refused: "+why)
	if err := r.journalOnce(ctx, "bind-refused/"+d.MAC+"/"+why, d, "warning", "fleetd: the device is not provisioned: "+why); err != nil {
		return unavailable("journal: %v", err)
	}
	return conflict("%s", why)
}
