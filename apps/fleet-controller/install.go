package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha512"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Installer renders the config a machine fetches on its first boot from
// disk, and releases the machine when nginx has served it.
//
// talos-attest calls POST /render at the end of a full intake, before it
// answers the machine its install code. The controller checks the device's
// state in NetBox and Tinkerbell, renders the config with the class inputs
// and the worker secrets, or the full bundle for a joining control plane,
// and writes it where nginx serves
// /talos/config?uuid=<uuid>&code=<code>. It then tails nginx's log of that
// location: a 200 burns the file and sets the device active, a 404 is
// journaled once per code, and a config nobody fetched is deleted after the
// TTL.
type Installer struct {
	Site     string
	Secret   []byte
	NetBox   *NetBox
	Kube     *Kube
	Renderer Renderer
	// Prepare readies the renderer before its first render; it runs again
	// after a failure.
	Prepare func(context.Context) error
	Store   *Store
	Tail    *Tail
	TTL     time.Duration
	// ControlPlanes lets a control-plane class render, from the full
	// secrets bundle the renderer holds. Off, a control plane is refused
	// and the owner renders it.
	ControlPlanes bool
	// Models is the model map: a class whose model says TPM 2.0 renders
	// only for a device that records it.
	Models map[string]Model
	// ControlPlaneTTL replaces TTL for a control plane's config, which
	// carries the cluster's CA keys.
	ControlPlaneTTL time.Duration
	// Bootstrap is the address of the control plane the Talos root
	// bootstraps etcd on. It never installs from here: a control plane the
	// controller renders joins the cluster that one serves.
	Bootstrap string
	// TailInterval is how often Run reads nginx's log.
	TailInterval time.Duration
	Metrics      *Metrics
	Now          func() time.Time

	mu         sync.Mutex
	prepared   bool
	journaled  map[string]time.Time
	unreleased map[string]bool
}

// notFoundEvery is how often a machine's 404s may reach its journal.
const notFoundEvery = 10 * time.Minute

// RenderRequest is talos-attest's call, signed with X-Fleet-Signature.
type RenderRequest struct {
	Serial string `json:"serial"`
	UUID   string `json:"uuid"`
	Node   string `json:"node"`
	Class  string `json:"class"`
	Code   string `json:"code"`
}

func reply(w http.ResponseWriter, status int, reason string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(map[string]string{"reason": reason}); err != nil {
		log.Printf("render reply: %v", err)
	}
}

// refusal is a render the device's state forbids (409) or one the controller
// cannot do now (503).
type refusal struct {
	status int
	reason string
}

func (r *refusal) Error() string { return r.reason }

func conflict(format string, a ...any) error {
	return &refusal{http.StatusConflict, fmt.Sprintf(format, a...)}
}

func unavailable(format string, a ...any) error {
	return &refusal{http.StatusServiceUnavailable, fmt.Sprintf(format, a...)}
}

func (i *Installer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if len(i.Secret) == 0 || i.Renderer == nil {
		reply(w, http.StatusServiceUnavailable, "the controller has no attest secret or no renderer")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 64<<10))
	if err != nil {
		reply(w, http.StatusBadRequest, "unreadable body")
		return
	}
	mac := hmac.New(sha512.New, i.Secret)
	mac.Write(body)
	want := hex.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(want), []byte(strings.ToLower(r.Header.Get("X-Fleet-Signature")))) {
		i.Metrics.RenderRejected.Add(1)
		reply(w, http.StatusUnauthorized, "bad signature")
		return
	}
	var req RenderRequest
	if err := json.Unmarshal(body, &req); err != nil {
		reply(w, http.StatusBadRequest, "the body is not a render request")
		return
	}
	if req.Serial == "" || !uuidPattern.MatchString(req.UUID) || !codePattern.MatchString(req.Code) {
		reply(w, http.StatusBadRequest, "serial, a lower-case uuid and a 43-character base64url code are required")
		return
	}
	d, err := i.render(r.Context(), req)
	var ref *refusal
	switch {
	case err == nil:
		i.Metrics.Rendered.Add(1)
		Audit("fleet.render", i.Site, d, d.LastWorkflow, "rendered")
		reply(w, http.StatusCreated, "rendered")
	case errors.As(err, &ref):
		if ref.status == http.StatusConflict {
			i.Metrics.RenderRefused.Add(1)
		} else {
			i.Metrics.RenderFailed.Add(1)
		}
		if d.Name == "" {
			d = Device{Serial: req.Serial, Name: req.Node, Class: req.Class}
		}
		Audit("fleet.render", i.Site, d, d.LastWorkflow, "refused: "+ref.reason)
		if ref.status == http.StatusConflict {
			reply(w, ref.status, ref.reason)
			return
		}
		log.Printf("render %s: %s", d.Name, ref.reason)
		reply(w, ref.status, "the controller cannot render now; its log says why")
	default:
		i.Metrics.RenderFailed.Add(1)
		log.Printf("render %s: %v", req.Serial, err)
		reply(w, http.StatusServiceUnavailable, "the controller cannot render now; its log says why")
	}
}

// render checks the gates in order and writes the config.
func (i *Installer) render(ctx context.Context, req RenderRequest) (Device, error) {
	d, err := i.NetBox.BySerial(ctx, i.Site, req.Serial)
	if errors.Is(err, ErrNoDevice) {
		return Device{}, conflict("NetBox has no %s node with that serial", i.Site)
	}
	if err != nil {
		return Device{}, unavailable("NetBox: %v", err)
	}
	if req.Node != "" && req.Node != d.Name {
		return d, conflict("the serial is another node in NetBox")
	}
	if req.Class != "" && req.Class != d.Class {
		return d, conflict("the node is of another class in NetBox")
	}
	if d.SMBIOSUUID != "" && d.SMBIOSUUID != req.UUID {
		return d, conflict("NetBox holds another SMBIOS UUID for the node")
	}
	if d.Status != "planned" {
		return d, conflict("%s is %s; only a planned device installs", d.Name, d.Status)
	}
	if !strings.HasPrefix(d.LastWorkflow, "provision-"+d.Name+"-") {
		return d, conflict("%s has no provision run in progress (last_workflow %q)", d.Name, d.LastWorkflow)
	}
	wf, err := i.Kube.Get(ctx, WorkflowResource, d.LastWorkflow)
	if errors.Is(err, ErrNotFound) {
		return d, conflict("the Workflow %s is gone", d.LastWorkflow)
	}
	if err != nil {
		return d, unavailable("Tinkerbell: %v", err)
	}
	if Finished(wf.State()) {
		return d, conflict("the Workflow %s has finished (%s)", d.LastWorkflow, wf.State())
	}
	spec, _ := wf["spec"].(map[string]any)
	if hm, _ := spec["hardwareMap"].(map[string]any); hm["install"] != "true" {
		return d, conflict("the Workflow %s installs nothing", d.LastWorkflow)
	}
	if i.Store.Spent(req.UUID, req.Code) {
		return d, conflict("the code is spent")
	}
	switch i.Renderer.MachineType(d.Class) {
	case "":
		return d, unavailable("the class inputs have no class %q", d.Class)
	case "controlplane":
		if !i.ControlPlanes {
			return d, conflict("%s is a control plane, which the owner renders", d.Name)
		}
		if d.Address == "" || d.Address == i.Bootstrap {
			return d, conflict("%s is the control plane the Talos root bootstraps, or has no address; only a joining control plane installs", d.Name)
		}
	}
	if d.TPM == "" && i.classHasTPM(d.Class) {
		return d, conflict("%s has no tpm_version, and its model carries a TPM 2.0; it renders once talos-attest records it", d.Name)
	}
	if err := i.prepare(ctx); err != nil {
		return d, unavailable("the renderer: %v", err)
	}
	cfg, err := i.Renderer.Render(ctx, Node{Name: d.Name, Class: d.Class, Disk: d.Disk, TPM: d.TPM, Address: d.Address})
	if err != nil {
		return d, unavailable("render %s: %v", d.Name, err)
	}
	p := Pending{
		UUID: req.UUID, Code: req.Code, Serial: d.Serial, Node: d.Name, Class: d.Class,
		Workflow: d.LastWorkflow, Rendered: i.Now(),
	}
	if err := i.Store.Put(p, cfg); errors.Is(err, ErrBurned) {
		return d, conflict("the code is spent")
	} else if err != nil {
		return d, unavailable("write the config: %v", err)
	}
	i.pending()
	comment := fmt.Sprintf("fleet-controller: rendered the %s config for %s's install; it is deleted when the node fetches it on its first boot, or unread after %s", d.Class, d.Name, i.ttl(d.Class))
	if err := i.NetBox.Update(ctx, d, "", nil, "info", comment); err != nil {
		log.Printf("journal the render of %s: %v", d.Name, err)
	}
	return d, nil
}

// classHasTPM says whether a model of the class carries a TPM 2.0.
func (i *Installer) classHasTPM(class string) bool {
	for _, m := range i.Models {
		if m.Class == class && m.TPM == "2.0" {
			return true
		}
	}
	return false
}

func (i *Installer) prepare(ctx context.Context) error {
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.prepared || i.Prepare == nil {
		return nil
	}
	if err := i.Prepare(ctx); err != nil {
		return err
	}
	i.prepared = true
	return nil
}

// Run follows nginx's log every interval and sweeps the store every
// sweepEvery intervals and after each release.
func (i *Installer) Run(ctx context.Context, interval time.Duration, sweepEvery int) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	// The first render then waits on no throwaway bundle; a failure here is
	// retried by the first render.
	if err := i.prepare(ctx); err != nil {
		log.Printf("the renderer: %v", err)
	}
	i.Sweep(ctx)
	for n := 1; ; n++ {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		served, err := i.Follow(ctx)
		if err != nil {
			log.Printf("talos-config log: %v", err)
		}
		if served || n%sweepEvery == 0 {
			i.Sweep(ctx)
		}
	}
}

// Follow handles the log lines written since the last call, and says
// whether any was a config served.
func (i *Installer) Follow(ctx context.Context) (bool, error) {
	lines, err := i.Tail.Read()
	if err != nil {
		return false, err
	}
	served := false
	for _, line := range lines {
		f, ok := parseFetch(line)
		if !ok {
			continue
		}
		switch {
		case f.Delivered():
			p, ok, err := i.Store.Served(f.UUID, f.Code, f.Sent, f.At)
			if err != nil {
				log.Printf("burn %s: %v", f.UUID, err)
			}
			if !ok {
				if p.Code != "" && p.Fetched.IsZero() {
					log.Printf("talos-config: %s's fetch sent %d bytes, not the file's; the file stays", p.Node, f.Sent)
				}
				continue
			}
			served = true
			log.Printf("nginx served %s's config at %s; the file is deleted", p.Node, timestamp(f.At))
		case f.Status == http.StatusOK || f.Status == http.StatusPartialContent:
			log.Printf("talos-config: an incomplete %s for uuid %q (%d, %d bytes); nothing is burned", f.Method, f.UUID, f.Status, f.Sent)
		case f.Status == http.StatusNotFound:
			i.notFound(ctx, f)
		default:
			log.Printf("talos-config: %d for uuid %q", f.Status, f.UUID)
		}
	}
	if len(lines) == 0 {
		return served, nil
	}
	return served, i.Tail.Save()
}

// notFound journals a 404 on the device whose config the store holds: the
// machine asked with a code other than the one rendered for it. A machine
// gets at most one such entry per notFoundEvery; a 404 for a UUID the store
// holds nothing for is only logged, so a flood of guesses reaches neither
// NetBox nor the journal.
func (i *Installer) notFound(ctx context.Context, f Fetch) {
	p, ok := i.Store.Holds(f.UUID)
	if !ok {
		log.Printf("talos-config: 404 for uuid %q", f.UUID)
		return
	}
	now := i.Now()
	i.mu.Lock()
	if i.journaled == nil {
		i.journaled = map[string]time.Time{}
	}
	for k, t := range i.journaled {
		if now.Sub(t) >= notFoundEvery {
			delete(i.journaled, k)
		}
	}
	_, recent := i.journaled[f.UUID]
	if !recent {
		i.journaled[f.UUID] = now
	}
	i.mu.Unlock()
	if recent {
		return
	}
	d, err := i.NetBox.BySerial(ctx, i.Site, p.Serial)
	if err == nil {
		comment := fmt.Sprintf("fleet-controller: at %s the node asked for its Talos config with a code other than the one rendered for it; nginx answered 404", timestamp(f.At))
		err = i.NetBox.Update(ctx, d, "", nil, "warning", comment)
	}
	if err != nil {
		log.Printf("journal the 404 of %s: %v", p.Node, err)
		i.mu.Lock()
		delete(i.journaled, f.UUID)
		i.mu.Unlock()
	}
}

// Sweep releases the served configs NetBox does not know of yet, deletes
// the configs nobody fetched within the TTL, and refreshes the metrics.
func (i *Installer) Sweep(ctx context.Context) {
	records, err := i.Store.Records()
	if err != nil {
		log.Printf("talos configs: %v", err)
		return
	}
	now := i.Now()
	for _, p := range records {
		switch {
		case !p.Released.IsZero():
			if err := i.Store.Drop(p, now); err != nil {
				log.Printf("drop %s's released config: %v", p.Node, err)
			}
		case !p.Fetched.IsZero():
			if err := i.release(ctx, p); err != nil {
				i.releaseFailed(ctx, p, err)
			}
		case now.Sub(p.Rendered) > i.ttl(p.Class):
			if err := i.expire(ctx, p); err != nil {
				log.Printf("expire %s: %v", p.Node, err)
			}
		}
	}
	if err := i.Store.Strays(now, i.strayTTL()); err != nil {
		log.Printf("talos configs: %v", err)
	}
	i.pending()
}

// release sets a device active once its config was served. A device the
// owner moved out of planned meanwhile keeps its status. The
// release is marked in the record as soon as NetBox has it, so a Drop that
// fails is retried alone, without a second update or journal entry.
func (i *Installer) release(ctx context.Context, p Pending) error {
	d, err := i.NetBox.BySerial(ctx, i.Site, p.Serial)
	if err != nil {
		return err
	}
	status := "active"
	comment := fmt.Sprintf("fleet-controller: the node fetched its Talos config at %s; the device is active and the file is deleted", timestamp(p.Fetched))
	if d.Status != "planned" {
		status = ""
		comment = fmt.Sprintf("fleet-controller: the node fetched its Talos config at %s and the file is deleted; the status stays %s", timestamp(p.Fetched), d.Status)
	}
	fields := map[string]any{"attest_consumed_at": timestamp(p.Fetched)}
	if err := i.NetBox.Update(ctx, d, status, fields, "success", comment); err != nil {
		return err
	}
	now := i.Now()
	i.mu.Lock()
	delete(i.unreleased, p.Code)
	i.mu.Unlock()
	i.Metrics.Released.Add(1)
	if status != "" {
		d.Status = status
	}
	Audit("fleet.release", i.Site, d, p.Workflow, "config fetched")
	if _, err := i.Store.Released(p, now); err != nil {
		log.Printf("mark %s released: %v", p.Node, err)
		return nil
	}
	if err := i.Store.Drop(p, now); err != nil {
		log.Printf("drop %s's released config: %v", p.Node, err)
	}
	return nil
}

// releaseFailed keeps a served config's record for the next sweep, which
// tries again, and journals the failure once.
func (i *Installer) releaseFailed(ctx context.Context, p Pending, err error) {
	log.Printf("release %s: %v", p.Node, err)
	i.mu.Lock()
	if i.unreleased == nil {
		i.unreleased = map[string]bool{}
	}
	told := i.unreleased[p.Code]
	i.mu.Unlock()
	if told {
		return
	}
	d, lookup := i.NetBox.BySerial(ctx, i.Site, p.Serial)
	if lookup != nil {
		return
	}
	comment := fmt.Sprintf("fleet-controller: the node fetched its Talos config at %s, and NetBox refused its release; the controller retries: %v", timestamp(p.Fetched), err)
	if i.NetBox.Update(ctx, d, "", nil, "danger", comment) == nil {
		i.mu.Lock()
		i.unreleased[p.Code] = true
		i.mu.Unlock()
	}
}

// ttl is how long a class's config waits unread: a control plane's, which
// carries the CA keys, waits ControlPlaneTTL when it is set.
func (i *Installer) ttl(class string) time.Duration {
	if i.ControlPlaneTTL > 0 && i.Renderer != nil && i.Renderer.MachineType(class) == "controlplane" {
		return i.ControlPlaneTTL
	}
	return i.TTL
}

// strayTTL is the age at which a file without a record goes. Its class is
// unknown, so it gets the shorter wait.
func (i *Installer) strayTTL() time.Duration {
	if i.ControlPlaneTTL > 0 && i.ControlPlaneTTL < i.TTL {
		return i.ControlPlaneTTL
	}
	return i.TTL
}

func (i *Installer) expire(ctx context.Context, p Pending) error {
	if err := i.Store.Drop(p, i.Now()); err != nil {
		return err
	}
	i.Metrics.Expired.Add(1)
	ttl := i.ttl(p.Class)
	d := Device{Serial: p.Serial, Name: p.Node, Class: p.Class}
	Audit("fleet.expire", i.Site, d, p.Workflow, "config unread after "+ttl.String())
	found, err := i.NetBox.BySerial(ctx, i.Site, p.Serial)
	if err != nil {
		return err
	}
	comment := fmt.Sprintf("fleet-controller: the Talos config rendered at %s was not fetched within %s and is deleted; provision the node again", timestamp(p.Rendered), ttl)
	return i.NetBox.Update(ctx, found, "", nil, "warning", comment)
}

// pending refreshes the counts and oldest times of the unread configs and
// of the served ones NetBox has no release for.
func (i *Installer) pending() {
	records, err := i.Store.Records()
	if err != nil {
		return
	}
	var unread, unreleased int
	var oldestUnread, oldestUnreleased time.Time
	for _, p := range records {
		if !p.Released.IsZero() {
			continue
		}
		if p.Fetched.IsZero() {
			unread++
			if oldestUnread.IsZero() || p.Rendered.Before(oldestUnread) {
				oldestUnread = p.Rendered
			}
			continue
		}
		unreleased++
		if oldestUnreleased.IsZero() || p.Fetched.Before(oldestUnreleased) {
			oldestUnreleased = p.Fetched
		}
	}
	i.Metrics.SetPending(unread, oldestUnread, unreleased, oldestUnreleased)
}
