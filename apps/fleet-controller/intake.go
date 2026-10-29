package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Intake takes a new machine's phone-home from HookOS. The agent image posts
// the machine's MAC, SMBIOS identity and disks before it waits for work; for
// a MAC neither NetBox nor Tinkerbell knows, the controller creates a
// Hardware and an attest-only Workflow, so the machine attests without
// anybody typing its facts. The call is unauthenticated and a claim: it makes
// only Tinkerbell objects, never a NetBox device, and talos-attest's verdict
// is the gate. Rate limits bound it per MAC and overall.
type Intake struct {
	Config  *Config
	NetBox  *NetBox
	Kube    *Kube
	Metrics *Metrics
	Now     func() time.Time
	// PerMAC is the least time between two intakes of one MAC, and Global
	// the most intakes per Window.
	PerMAC time.Duration
	Global int
	Window time.Duration

	mu     sync.Mutex
	byMAC  map[string]time.Time
	recent []time.Time
}

// Labels and annotations on an intake's Hardware and Workflow.
const (
	IntakeLabel      = "lolwtf.ca/intake"
	ActionIntake     = "intake"
	SerialAnnotation = "lolwtf.ca/intake-serial"
	UUIDAnnotation   = "lolwtf.ca/intake-uuid"
	ModelAnnotation  = "lolwtf.ca/intake-model"
)

// IntakeDisk is one block device the agent lists: its kernel name, its size
// in bytes and its transport (nvme, sata, usb, virtio, mmc or "").
type IntakeDisk struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
	Tran string `json:"tran"`
}

// IntakeRequest is the agent's body.
type IntakeRequest struct {
	MAC    string       `json:"mac"`
	Serial string       `json:"serial"`
	UUID   string       `json:"uuid"`
	Model  string       `json:"model"`
	SKU    string       `json:"sku"`
	BIOS   string       `json:"bios"`
	Disks  []IntakeDisk `json:"disks"`
}

var (
	macPattern        = regexp.MustCompile(`^([0-9a-f]{2}:){5}[0-9a-f]{2}$`)
	intakeUUIDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	blockNamePattern  = regexp.MustCompile(`^[a-z][a-z0-9]{0,31}$`)
)

func printable(s string, max int) bool {
	if len(s) > max {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < 0x20 || s[i] > 0x7e {
			return false
		}
	}
	return true
}

// validate normalizes the request and says what is wrong with it.
func (q *IntakeRequest) validate() string {
	q.MAC = strings.ToLower(strings.TrimSpace(q.MAC))
	q.Serial = strings.TrimSpace(q.Serial)
	q.UUID = strings.ToLower(strings.TrimSpace(q.UUID))
	q.Model, q.SKU, q.BIOS = strings.TrimSpace(q.Model), strings.TrimSpace(q.SKU), strings.TrimSpace(q.BIOS)
	switch {
	case !macPattern.MatchString(q.MAC):
		return "mac is not aa:bb:cc:dd:ee:ff"
	case q.MAC == "00:00:00:00:00:00" || strings.ContainsRune("13579bdf", rune(q.MAC[1])):
		return "mac is not a unicast address"
	case q.Serial == "" || !printable(q.Serial, 64):
		return "serial is not 1 to 64 printable ASCII characters"
	case !intakeUUIDPattern.MatchString(q.UUID):
		return "uuid is not an SMBIOS UUID"
	case !printable(q.Model, 128) || !printable(q.SKU, 128) || !printable(q.BIOS, 128):
		return "model, sku and bios are at most 128 printable ASCII characters"
	case len(q.Disks) > 32:
		return "more than 32 disks"
	}
	for _, d := range q.Disks {
		if !blockNamePattern.MatchString(d.Name) || d.Size < 0 || !printable(d.Tran, 16) {
			return "a disk is not a kernel block device name, a size in bytes and a transport"
		}
	}
	return ""
}

// installDisk is the disk an intake's Hardware names: the first NVMe disk,
// else the first other disk that is no USB stick, else the model's disk.
func installDisk(disks []IntakeDisk, model Model) string {
	for _, d := range disks {
		if d.Tran == "nvme" || strings.HasPrefix(d.Name, "nvme") {
			return "/dev/" + d.Name
		}
	}
	for _, d := range disks {
		if d.Tran != "usb" && !virtualDisk(d.Name) {
			return "/dev/" + d.Name
		}
	}
	return model.Disk
}

func virtualDisk(name string) bool {
	for _, p := range []string{"loop", "ram", "zram", "sr", "fd", "nbd"} {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}

// MACSlug is a MAC as a Kubernetes name: 38-22-e2-2d-96-44.
func MACSlug(mac string) string { return strings.ReplaceAll(strings.ToLower(mac), ":", "-") }

func intakeReply(w http.ResponseWriter, status int, body map[string]string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		log.Printf("intake reply: %v", err)
	}
}

// reserve takes a slot under both limits, or says no; the release func
// gives the slot back for a call the controller failed.
func (in *Intake) reserve(mac string) (bool, func()) {
	in.mu.Lock()
	defer in.mu.Unlock()
	now := in.Now()
	if in.byMAC == nil {
		in.byMAC = map[string]time.Time{}
	}
	for k, t := range in.byMAC {
		if now.Sub(t) >= in.PerMAC {
			delete(in.byMAC, k)
		}
	}
	kept := in.recent[:0]
	for _, t := range in.recent {
		if now.Sub(t) < in.Window {
			kept = append(kept, t)
		}
	}
	in.recent = kept
	if _, ok := in.byMAC[mac]; ok || len(in.recent) >= in.Global {
		return false, func() {}
	}
	in.byMAC[mac] = now
	in.recent = append(in.recent, now)
	return true, func() {
		in.mu.Lock()
		defer in.mu.Unlock()
		if in.byMAC[mac].Equal(now) {
			delete(in.byMAC, mac)
		}
		for i, t := range in.recent {
			if t.Equal(now) {
				in.recent = append(in.recent[:i], in.recent[i+1:]...)
				break
			}
		}
	}
}

func (in *Intake) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 16<<10+1))
	if err != nil || len(body) > 16<<10 {
		in.Metrics.IntakeInvalid.Add(1)
		intakeReply(w, http.StatusBadRequest, map[string]string{"reason": "the body is unreadable or over 16 KiB"})
		return
	}
	var req IntakeRequest
	if err := json.Unmarshal(body, &req); err != nil {
		in.Metrics.IntakeInvalid.Add(1)
		intakeReply(w, http.StatusBadRequest, map[string]string{"reason": "the body is not an intake"})
		return
	}
	if why := req.validate(); why != "" {
		in.Metrics.IntakeInvalid.Add(1)
		intakeReply(w, http.StatusBadRequest, map[string]string{"reason": why})
		return
	}
	ok, release := in.reserve(req.MAC)
	if !ok {
		in.Metrics.IntakeLimited.Add(1)
		intakeReply(w, http.StatusTooManyRequests, map[string]string{"reason": "too many intakes; try again later"})
		return
	}
	d := Device{Name: MACSlug(req.MAC), Serial: req.Serial, MAC: req.MAC}
	state, workflow, err := in.intake(r.Context(), req)
	if err != nil {
		release()
		in.Metrics.IntakeFailed.Add(1)
		log.Printf("intake %s: %v", req.MAC, err)
		intakeReply(w, http.StatusServiceUnavailable, map[string]string{"reason": "the controller cannot take the intake now; its log says why"})
		return
	}
	if workflow == "" {
		in.Metrics.IntakeKnown.Add(1)
		Audit("fleet.intake", in.Config.Site, d, "", "known: "+state)
		intakeReply(w, http.StatusOK, map[string]string{"state": "known"})
		return
	}
	in.Metrics.IntakeCreated.Add(1)
	Audit("fleet.intake", in.Config.Site, d, workflow, fmt.Sprintf("intake: %s %s, uuid %s", req.Model, req.Serial, req.UUID))
	intakeReply(w, http.StatusCreated, map[string]string{"state": "intake", "workflow": workflow})
}

// intake answers why a MAC is known, or makes its Hardware and Workflow and
// names the Workflow.
func (in *Intake) intake(ctx context.Context, req IntakeRequest) (string, string, error) {
	known, err := in.NetBox.HasMAC(ctx, req.MAC)
	if err != nil {
		return "", "", fmt.Errorf("NetBox: %w", err)
	}
	if known {
		return "a NetBox device has the MAC", "", nil
	}
	hardware, err := in.Kube.List(ctx, HardwareResource, "")
	if err != nil {
		return "", "", fmt.Errorf("list Hardware: %w", err)
	}
	for _, h := range hardware {
		if hardwareMAC(h) == req.MAC {
			return "Hardware " + h.Name() + " has the MAC", "", nil
		}
	}
	model := in.Config.Models[req.Model]
	disk := installDisk(req.Disks, model)
	if disk == "" {
		disk = "/dev/sda"
	}
	hw := in.Config.IntakeHardware(req, disk)
	if err := in.Kube.Apply(ctx, HardwareResource, hw); err != nil {
		return "", "", fmt.Errorf("apply Hardware: %w", err)
	}
	wf := in.Config.IntakeWorkflow(hw.Name(), in.Now())
	if err := in.Kube.Create(ctx, WorkflowResource, wf); err != nil {
		// Without its Workflow the Hardware would answer the next call
		// "known" for a day.
		if derr := in.Kube.Delete(ctx, HardwareResource, hw.Name()); derr != nil {
			log.Printf("intake %s: delete Hardware after the Workflow failed: %v", req.MAC, derr)
		}
		return "", "", fmt.Errorf("create Workflow: %w", err)
	}
	in.Metrics.WorkflowsCreated.Add(1)
	return "", wf.Name(), nil
}

// hardwareMAC is the first interface's MAC of a Hardware, lower case.
func hardwareMAC(o Object) string {
	spec, _ := o["spec"].(map[string]any)
	ifaces, _ := spec["interfaces"].([]any)
	for _, i := range ifaces {
		im, _ := i.(map[string]any)
		dhcp, _ := im["dhcp"].(map[string]any)
		if mac, _ := dhcp["mac"].(string); mac != "" {
			return strings.ToLower(mac)
		}
	}
	return ""
}

func (o Object) annotation(key string) string {
	a, _ := o.metadata()["annotations"].(map[string]any)
	s, _ := a[key].(string)
	return s
}

// IntakeHardware is the Hardware of a machine that phoned home: named for
// its MAC, labelled as an intake, with the claim's serial, UUID and model as
// annotations, and the same HookOS chain as a device's.
func (c Config) IntakeHardware(req IntakeRequest, disk string) Object {
	name := MACSlug(req.MAC)
	hw := c.Hardware(Device{Name: name, MAC: req.MAC, Disk: disk, BMCType: "none"})
	meta := hw.metadata()
	meta["labels"].(map[string]any)[IntakeLabel] = "true"
	meta["annotations"] = map[string]any{
		SerialAnnotation: req.Serial,
		UUIDAnnotation:   req.UUID,
		ModelAnnotation:  req.Model,
	}
	return hw
}

// IntakeWorkflow is the attest-only run of an intake: the provision
// Template with attest and nothing else. It boots nothing: the machine's
// agent is already connected and waiting for work.
func (c Config) IntakeWorkflow(hardware string, now time.Time) Object {
	return Object{
		"apiVersion": WorkflowResource.apiVersion(),
		"kind":       WorkflowResource.Kind,
		"metadata": map[string]any{
			"name": fmt.Sprintf("%s-%s-%d", ActionIntake, hardware, now.Unix()),
			"labels": map[string]any{
				ManagedLabel: FieldManager, NodeLabel: hardware, ActionLabel: ActionIntake, IntakeLabel: "true",
			},
		},
		"spec": map[string]any{
			"templateRef": c.Template,
			"hardwareRef": hardware,
			"hardwareMap": map[string]any{
				"wipe":            "false",
				"attest":          "true",
				"retire":          "false",
				"install":         "false",
				"installer_image": "",
				"attest_url":      c.AttestURL,
				"ntp_server":      c.NTPServer,
			},
			"bootOptions": map[string]any{"toggleAllowNetboot": true},
		},
	}
}

// intakes is a pass's view of the intake objects: each Hardware by MAC, and
// each Hardware's newest Workflow.
type intakes struct {
	byMAC  map[string]Object
	newest map[string]Object
	all    map[string][]Object
	names  map[string]bool
}

func (r *Reconciler) intakes(ctx context.Context) (intakes, error) {
	in := intakes{byMAC: map[string]Object{}, newest: map[string]Object{}, all: map[string][]Object{}, names: map[string]bool{}}
	hws, err := r.Kube.List(ctx, HardwareResource, IntakeLabel+"=true")
	if err != nil {
		return in, fmt.Errorf("list intake Hardware: %w", err)
	}
	for _, h := range hws {
		in.names[h.Name()] = true
		if mac := hardwareMAC(h); mac != "" {
			in.byMAC[mac] = h
		}
	}
	wfs, err := r.Kube.List(ctx, WorkflowResource, IntakeLabel+"=true")
	if err != nil {
		return in, fmt.Errorf("list intake Workflows: %w", err)
	}
	sortByCreatedDesc(wfs)
	for _, wf := range wfs {
		hw := wf.Labels()[NodeLabel]
		in.all[hw] = append(in.all[hw], wf)
		if _, ok := in.newest[hw]; !ok {
			in.newest[hw] = wf
		}
	}
	return in, nil
}

// forSerial finds the intake of a device NetBox holds no MAC for: the one
// intake that claimed the serial, and the device's attested SMBIOS UUID when
// it has one, and whose attest run succeeded. Each of those is a claim, since
// an agent reports its own run, so the match is only taken when exactly one
// intake qualifies: a second claimant makes it ambiguous, and nothing binds.
// It says how many qualify.
func (in intakes) forSerial(serial, uuid string) (Object, int) {
	var found Object
	n := 0
	for _, hw := range in.byMAC {
		wf := in.newest[hw.Name()]
		if wf == nil || !Succeeded(wf.State()) || !strings.EqualFold(hw.annotation(SerialAnnotation), serial) {
			continue
		}
		if uuid != "" && !strings.EqualFold(hw.annotation(UUIDAnnotation), uuid) {
			continue
		}
		found = hw
		n++
	}
	return found, n
}

// dropIntake deletes an intake's Workflows and its Hardware.
// The Hardware goes first: it is what holds the MAC, and a Workflow left
// behind is an orphan the next pass deletes.
func (r *Reconciler) dropIntake(ctx context.Context, in intakes, hw Object) error {
	if err := r.Kube.Delete(ctx, HardwareResource, hw.Name()); err != nil {
		return fmt.Errorf("delete Hardware %s: %w", hw.Name(), err)
	}
	for _, wf := range in.all[hw.Name()] {
		if err := r.Kube.Delete(ctx, WorkflowResource, wf.Name()); err != nil {
			return fmt.Errorf("delete %s: %w", wf.Name(), err)
		}
	}
	return nil
}

// dropOrphans deletes the intake Workflows whose Hardware is gone.
func (r *Reconciler) dropOrphans(ctx context.Context, in intakes) error {
	var errs []error
	for name, wfs := range in.all {
		if in.names[name] {
			continue
		}
		for _, wf := range wfs {
			if err := r.Kube.Delete(ctx, WorkflowResource, wf.Name()); err != nil {
				errs = append(errs, fmt.Errorf("delete orphan %s: %w", wf.Name(), err))
			}
		}
	}
	return errors.Join(errs...)
}

// expireIntakes deletes the intakes older than the TTL whose MAC no device
// holds: a machine that never attested, or whose claim nobody approved. It
// may phone home again afterwards.
func (r *Reconciler) expireIntakes(ctx context.Context, devices []Device, in intakes) error {
	held := map[string]bool{}
	serials := map[string]bool{}
	for _, d := range devices {
		if d.MAC != "" {
			held[d.MAC] = true
		} else if d.Serial != "" {
			serials[strings.ToLower(d.Serial)] = true
		}
	}
	cutoff := r.Now().Add(-r.Config.IntakeTTL)
	var errs []error
	for mac, hw := range in.byMAC {
		created := hw.Created()
		if held[mac] || serials[strings.ToLower(hw.annotation(SerialAnnotation))] || created.IsZero() || !created.Before(cutoff) {
			continue
		}
		if err := r.dropIntake(ctx, in, hw); err != nil {
			errs = append(errs, err)
			continue
		}
		Audit("fleet.intake", r.Config.Site, Device{Name: hw.Name(), Serial: hw.annotation(SerialAnnotation), MAC: mac}, "", "expired: no device after "+r.Config.IntakeTTL.String())
	}
	return errors.Join(errs...)
}
