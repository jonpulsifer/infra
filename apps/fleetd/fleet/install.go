package fleet

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Installer renders the config a machine fetches on its first boot from
// disk, serves it once, and releases the machine when it is served.
//
// Admit renders at the end of an intake pass, before the verifier answers
// the machine its install code. The installer checks the device's state in
// NetBox and Tinkerbell, renders the config with the class inputs and the
// worker secrets, or the full bundle for a joining control plane, and keeps
// it in memory for GET /talos/config?uuid=<uuid>&code=<code>. The first
// complete GET burns it and sets the device active; a GET with another code
// is journaled once per machine and code window; a config nobody fetched
// goes after its TTL.
type Installer struct {
	Site     string
	NetBox   *NetBox
	Kube     *Kube
	Renderer Renderer
	// Prepare readies the renderer before its first render; it runs again
	// after a failure.
	Prepare func(context.Context) error
	Configs *Configs
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
	// fleet renders joins the cluster that one serves.
	Bootstrap string
	Metrics   *Metrics
	Now       func() time.Time

	mu         sync.Mutex
	prepared   bool
	journaled  map[string]time.Time
	unreleased map[string]bool
}

// notFoundEvery is how often a machine's 404s may reach its journal.
const notFoundEvery = 10 * time.Minute

// RenderRequest is an intake pass's install: the machine, and the code its
// config renders under.
type RenderRequest struct {
	Serial string
	UUID   string
	Node   string
	Class  string
	Code   string
}

// refusal is a render the device's state forbids (conflict) or one the fleet
// cannot do now (unavailable).
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

// Render checks the request and the device, renders the config and keeps it
// for the node's first boot. Every outcome is counted and audited.
func (i *Installer) Render(ctx context.Context, req RenderRequest) error {
	if i.Renderer == nil {
		i.Metrics.RenderFailed.Add(1)
		return unavailable("the fleet has no renderer")
	}
	if req.Serial == "" || !uuidPattern.MatchString(req.UUID) || !codePattern.MatchString(req.Code) {
		i.Metrics.RenderRefused.Add(1)
		return conflict("serial, a lower-case uuid and a 43-character base64url code are required")
	}
	d, err := i.render(ctx, req)
	var ref *refusal
	switch {
	case err == nil:
		i.Metrics.Rendered.Add(1)
		Audit("fleet.render", i.Site, d, d.LastWorkflow, "rendered")
		return nil
	case errors.As(err, &ref):
		if ref.status == http.StatusConflict {
			i.Metrics.RenderRefused.Add(1)
		} else {
			i.Metrics.RenderFailed.Add(1)
			log.Printf("render %s: %s", req.Node, ref.reason)
		}
		if d.Name == "" {
			d = Device{Serial: req.Serial, Name: req.Node, Class: req.Class}
		}
		Audit("fleet.render", i.Site, d, d.LastWorkflow, "refused: "+ref.reason)
		return err
	default:
		i.Metrics.RenderFailed.Add(1)
		log.Printf("render %s: %v", req.Serial, err)
		return unavailable("render: %v", err)
	}
}

// render checks the gates in order and keeps the config.
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
	if i.Configs.Spent(req.UUID, req.Code) {
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
		return d, conflict("%s has no tpm_version, and its model carries a TPM 2.0; it renders once the verifier records it", d.Name)
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
		Workflow: d.LastWorkflow, Rendered: i.Now(), TTL: i.ttl(d.Class),
	}
	if err := i.Configs.Put(p, cfg); errors.Is(err, ErrBurned) {
		return d, conflict("the code is spent")
	} else if err != nil {
		return d, unavailable("keep the config: %v", err)
	}
	i.pending()
	comment := fmt.Sprintf("fleetd: rendered the %s config for %s's install; it is dropped when the node fetches it on its first boot, or unread after %s", d.Class, d.Name, p.TTL)
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

// Warm readies the renderer at start, so the first render waits on no
// throwaway bundle; a failure here is retried by the first render.
func (i *Installer) Warm(ctx context.Context) {
	if i.Renderer == nil {
		return
	}
	if err := i.prepare(ctx); err != nil {
		log.Printf("the renderer: %v", err)
	}
}

// ServeHTTP answers GET /talos/config?uuid=<uuid>&code=<code> with the
// config whole, and burns it once all of it is written. A HEAD, a
// conditional request or another method serves nothing; a Range is ignored,
// so the answer is always the whole file.
func (i *Installer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if r.Header.Get("If-None-Match") != "" || r.Header.Get("If-Modified-Since") != "" {
		http.Error(w, "conditional requests are refused", http.StatusBadRequest)
		return
	}
	uuid, code := r.URL.Query().Get("uuid"), r.URL.Query().Get("code")
	if !uuidPattern.MatchString(uuid) || !codePattern.MatchString(code) {
		http.NotFound(w, r)
		return
	}
	now := i.Now()
	p, cfg, ok := i.Configs.Get(uuid, code, now)
	if !ok {
		i.notFound(r.Context(), uuid, code, now)
		http.NotFound(w, r)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/yaml")
	h.Set("Cache-Control", "no-store")
	h.Set("Content-Length", strconv.Itoa(len(cfg)))
	w.WriteHeader(http.StatusOK)
	n, err := w.Write(cfg)
	if err == nil {
		err = http.NewResponseController(w).Flush()
	}
	if err != nil || n != len(cfg) {
		log.Printf("talos-config: %s's fetch ended after %d of %d bytes; the config stays", p.Node, n, len(cfg))
		return
	}
	served, ok := i.Configs.Burn(uuid, code, now)
	if !ok {
		return
	}
	log.Printf("served %s's config at %s; it is dropped", served.Node, timestamp(now))
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 30*time.Second)
	defer cancel()
	if err := i.release(ctx, served); err != nil {
		i.releaseFailed(ctx, served, err)
	}
	i.pending()
}

// notFound journals a fetch with a code other than the one rendered for the
// machine. A machine gets at most one such entry per notFoundEvery; a fetch
// for a UUID with no config is only logged, so a flood of guesses reaches
// neither NetBox nor the journal, and a fetch of a config past its TTL is
// the expiry's to journal.
func (i *Installer) notFound(ctx context.Context, uuid, code string, now time.Time) {
	p, ok := i.Configs.Holds(uuid)
	if !ok || p.Code == code {
		log.Printf("talos-config: 404 for uuid %q", uuid)
		return
	}
	i.mu.Lock()
	if i.journaled == nil {
		i.journaled = map[string]time.Time{}
	}
	for k, t := range i.journaled {
		if now.Sub(t) >= notFoundEvery {
			delete(i.journaled, k)
		}
	}
	_, recent := i.journaled[uuid]
	if !recent {
		i.journaled[uuid] = now
	}
	i.mu.Unlock()
	if recent {
		return
	}
	d, err := i.NetBox.BySerial(ctx, i.Site, p.Serial)
	if err == nil {
		comment := fmt.Sprintf("fleetd: at %s the node asked for its Talos config with a code other than the one rendered for it, and got 404", timestamp(now))
		err = i.NetBox.Update(ctx, d, "", nil, "warning", comment)
	}
	if err != nil {
		log.Printf("journal the 404 of %s: %v", p.Node, err)
		i.mu.Lock()
		delete(i.journaled, uuid)
		i.mu.Unlock()
	}
}

// Tick expires the configs nobody fetched within their TTL, retries the
// releases NetBox refused, and refreshes the metrics. Each reconcile pass
// runs it.
func (i *Installer) Tick(ctx context.Context) {
	now := i.Now()
	for _, p := range i.Configs.Expire(now) {
		if err := i.expire(ctx, p); err != nil {
			log.Printf("expire %s: %v", p.Node, err)
		}
	}
	for _, p := range i.Configs.Unreleased() {
		if err := i.release(ctx, p); err != nil {
			i.releaseFailed(ctx, p, err)
		}
	}
	i.pending()
}

// release sets a device active once its config was served. A device the
// owner moved out of planned meanwhile keeps its status.
func (i *Installer) release(ctx context.Context, p Pending) error {
	d, err := i.NetBox.BySerial(ctx, i.Site, p.Serial)
	if err != nil {
		return err
	}
	status := "active"
	comment := fmt.Sprintf("fleetd: the node fetched its Talos config at %s; the device is active and the config is dropped", timestamp(p.Fetched))
	if d.Status != "planned" {
		status = ""
		comment = fmt.Sprintf("fleetd: the node fetched its Talos config at %s and the config is dropped; the status stays %s", timestamp(p.Fetched), d.Status)
	}
	fields := map[string]any{"attest_consumed_at": timestamp(p.Fetched)}
	if err := i.NetBox.Update(ctx, d, status, fields, "success", comment); err != nil {
		return err
	}
	i.Configs.Released(p)
	i.mu.Lock()
	delete(i.unreleased, p.Code)
	i.mu.Unlock()
	i.Metrics.Released.Add(1)
	if status != "" {
		d.Status = status
	}
	Audit("fleet.release", i.Site, d, p.Workflow, "config fetched")
	return nil
}

// releaseFailed keeps a served config's record for the next pass, which
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
	comment := fmt.Sprintf("fleetd: the node fetched its Talos config at %s, and NetBox refused its release; fleetd retries: %v", timestamp(p.Fetched), err)
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

func (i *Installer) expire(ctx context.Context, p Pending) error {
	i.Metrics.Expired.Add(1)
	d := Device{Serial: p.Serial, Name: p.Node, Class: p.Class}
	Audit("fleet.expire", i.Site, d, p.Workflow, "config unread after "+p.TTL.String())
	found, err := i.NetBox.BySerial(ctx, i.Site, p.Serial)
	if err != nil {
		return err
	}
	comment := fmt.Sprintf("fleetd: the Talos config rendered at %s was not fetched within %s and is dropped; provision the node again", timestamp(p.Rendered), p.TTL)
	return i.NetBox.Update(ctx, found, "", nil, "warning", comment)
}

// pending refreshes the counts and oldest times of the unread configs and
// of the served ones NetBox has no release for.
func (i *Installer) pending() {
	unread, oldestUnread, unreleased, oldestUnreleased := i.Configs.Stats()
	i.Metrics.SetPending(unread, oldestUnread, unreleased, oldestUnreleased)
}
