package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
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
// is the gate. Rate limits bound it per MAC, per source address and in the
// intakes it creates.
type Intake struct {
	Config  *Config
	NetBox  *NetBox
	Kube    *Kube
	Metrics *Metrics
	Now     func() time.Time
	// PerMAC is the least time between two calls for one MAC, PerSource the
	// most calls from one address per Window, and Global the most intakes
	// created per Window. The source is nginx's X-Forwarded-For, which a
	// caller on the Anchor network can set itself, so the per-MAC and global
	// limits are the bound.
	PerMAC    time.Duration
	PerSource int
	Global    int
	Window    time.Duration

	mu       sync.Mutex
	byMAC    map[string]time.Time
	bySource map[string][]time.Time
	created  []time.Time
}

// errIntakesFull is a new intake past the global limit.
var errIntakesFull = errors.New("too many intakes this hour")

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

func within(ts []time.Time, now time.Time, window time.Duration) []time.Time {
	kept := ts[:0]
	for _, t := range ts {
		if now.Sub(t) < window {
			kept = append(kept, t)
		}
	}
	return kept
}

// admit takes a call's slots under the per-MAC and per-source limits, or
// says no; the release func gives the MAC's slot back for a call that made
// nothing.
func (in *Intake) admit(mac, source string) (bool, func()) {
	in.mu.Lock()
	defer in.mu.Unlock()
	now := in.Now()
	if in.byMAC == nil {
		in.byMAC, in.bySource = map[string]time.Time{}, map[string][]time.Time{}
	}
	for k, t := range in.byMAC {
		if now.Sub(t) >= in.PerMAC {
			delete(in.byMAC, k)
		}
	}
	for k, ts := range in.bySource {
		if in.bySource[k] = within(ts, now, in.Window); len(in.bySource[k]) == 0 {
			delete(in.bySource, k)
		}
	}
	if _, ok := in.byMAC[mac]; ok || len(in.bySource[source]) >= in.PerSource {
		return false, func() {}
	}
	in.byMAC[mac] = now
	in.bySource[source] = append(in.bySource[source], now)
	return true, func() {
		in.mu.Lock()
		defer in.mu.Unlock()
		if in.byMAC[mac].Equal(now) {
			delete(in.byMAC, mac)
		}
	}
}

// create takes a slot under the global limit, which counts only the intakes
// made, or says no; the release func gives it back when the making failed.
func (in *Intake) create() (bool, func()) {
	in.mu.Lock()
	defer in.mu.Unlock()
	now := in.Now()
	in.created = within(in.created, now, in.Window)
	if len(in.created) >= in.Global {
		return false, func() {}
	}
	in.created = append(in.created, now)
	return true, func() {
		in.mu.Lock()
		defer in.mu.Unlock()
		for i, t := range in.created {
			if t.Equal(now) {
				in.created = append(in.created[:i], in.created[i+1:]...)
				return
			}
		}
	}
}

// source is the caller's address: the first X-Forwarded-For entry nginx
// set, else the connection's.
func source(r *http.Request) string {
	if f := r.Header.Get("X-Forwarded-For"); f != "" {
		first, _, _ := strings.Cut(f, ",")
		return strings.TrimSpace(first)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (in *Intake) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 16<<10))
	if err != nil {
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
	ok, release := in.admit(req.MAC, source(r))
	if !ok {
		in.Metrics.IntakeLimited.Add(1)
		intakeReply(w, http.StatusTooManyRequests, map[string]string{"reason": "too many intakes; try again later"})
		return
	}
	d := Device{Name: MACSlug(req.MAC), Serial: req.Serial, MAC: req.MAC}
	state, workflow, err := in.intake(r.Context(), req)
	if errors.Is(err, errIntakesFull) {
		release()
		in.Metrics.IntakeLimited.Add(1)
		intakeReply(w, http.StatusTooManyRequests, map[string]string{"reason": "too many intakes; try again later"})
		return
	}
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
	ok, release := in.create()
	if !ok {
		return "", "", errIntakesFull
	}
	hw := in.Config.IntakeHardware(req, disk)
	if err := in.Kube.Apply(ctx, HardwareResource, hw); err != nil {
		release()
		return "", "", fmt.Errorf("apply Hardware: %w", err)
	}
	wf := in.Config.IntakeWorkflow(hw.Name(), in.Now())
	if err := in.Kube.Create(ctx, WorkflowResource, wf); err != nil {
		release()
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

// FailedIntakeTTL is the age at which an intake whose run failed, or never
// came, is deleted, so that the machine may phone home again.
const FailedIntakeTTL = time.Hour

// expireIntakes deletes stale intakes. One whose run failed goes after an
// hour, whoever holds its MAC: the machine phones home again on its next
// boot. One that runs or succeeded goes after the TTL when no device holds
// its MAC: a machine that never attested, or whose claim nobody approved.
func (r *Reconciler) expireIntakes(ctx context.Context, devices []Device, in intakes) error {
	held := map[string]bool{}
	for _, d := range devices {
		if d.MAC != "" {
			held[d.MAC] = true
		}
	}
	now := r.Now()
	var errs []error
	for mac, hw := range in.byMAC {
		created := hw.Created()
		if created.IsZero() {
			continue
		}
		wf := in.newest[hw.Name()]
		failed := wf == nil || Finished(wf.State()) && !Succeeded(wf.State())
		why := ""
		switch {
		case failed && now.Sub(created) > FailedIntakeTTL:
			why = "expired: its run failed"
		case !failed && !held[mac] && now.Sub(created) > r.Config.IntakeTTL:
			why = "expired: no device after " + r.Config.IntakeTTL.String()
		default:
			continue
		}
		if err := r.dropIntake(ctx, in, hw); err != nil {
			errs = append(errs, err)
			continue
		}
		Audit("fleet.intake", r.Config.Site, Device{Name: hw.Name(), Serial: hw.annotation(SerialAnnotation), MAC: mac}, "", why)
	}
	return errors.Join(errs...)
}
