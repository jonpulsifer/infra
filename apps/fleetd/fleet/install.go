package fleet

import (
	"context"
	"errors"
	"fmt"
	"io"
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
// NetBox and Tinkerbell, renders the config with the class inputs, the
// worker secrets and a bootstrap token it creates for the worker alone, or
// the full bundle for a joining control plane, and keeps
// it in memory for GET /talos/config?uuid=<uuid>&code=<code>. The first GET
// whose every byte the node acknowledged burns it and sets the device
// active; a GET with another code
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
	// ControlPlaneTTL replaces TTL for a control plane's config, which
	// carries the cluster's CA keys.
	ControlPlaneTTL time.Duration
	// Bootstrap is the address of the control plane the Talos root
	// bootstraps etcd on. It never installs from here: a control plane the
	// fleet renders joins the cluster that one serves.
	Bootstrap string
	// Tokens creates each worker config's own bootstrap token in the
	// cluster. Without it no worker renders.
	Tokens  JoinTokens
	Metrics *Metrics
	Now     func() time.Time

	mu         sync.Mutex
	prepared   bool
	journaled  map[string]time.Time
	lastLookup time.Time
	// missingTold names the machine and run pairs whose missing config is
	// journaled.
	missingTold map[string]bool
	// refetchTold names the machine and run pairs whose ask for a served
	// config is journaled.
	refetchTold map[string]bool
	unreleased  map[string]bool
	// releasing names the codes whose release runs now, so a pass's retry
	// and a fetch's release never write it twice.
	releasing map[string]bool
	inflight  sync.WaitGroup
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
	if err := i.gates(ctx, d); err != nil {
		return d, err
	}
	n := Node{Name: d.Name, Class: d.Class, Disk: d.Disk, TPM: d.TPM, Address: d.Address}
	rendered, ttl := i.Now(), i.ttl(d.Class)
	if i.Renderer.MachineType(d.Class) == "worker" {
		token, err := i.Tokens.Mint(ctx, d.Name, rendered.Add(ttl+JoinTokenGrace))
		if err != nil {
			return d, unavailable("create %s's bootstrap token: %v", d.Name, err)
		}
		n.BootstrapToken = token
	}
	cfg, err := i.Renderer.Render(ctx, n)
	if err != nil {
		return d, unavailable("render %s: %v", d.Name, err)
	}
	p := Pending{
		UUID: req.UUID, Code: req.Code, Serial: d.Serial, Node: d.Name, Class: d.Class,
		Workflow: d.LastWorkflow, Rendered: rendered, TTL: ttl,
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

// Ready checks what the device itself must pass before fleetd starts a run
// that installs it: the class, the control-plane gate, the TPM version and
// the renderer. Admit asks before it creates the Workflow.
func (i *Installer) Ready(ctx context.Context, d Device) error {
	if i.Renderer == nil {
		return unavailable("the fleet has no renderer")
	}
	return i.gates(ctx, d)
}

// gates are the device's render gates.
func (i *Installer) gates(ctx context.Context, d Device) error {
	switch i.Renderer.MachineType(d.Class) {
	case "":
		return unavailable("the class inputs have no class %q", d.Class)
	case "worker":
		if i.Tokens == nil {
			return unavailable("%s is a worker, whose config carries a bootstrap token fleetd creates in the cluster, and fleetd has no credentials for the cluster's API", d.Name)
		}
	case "controlplane":
		if !i.ControlPlanes {
			return conflict("%s is a control plane, which the owner renders", d.Name)
		}
		if d.Address == "" || d.Address == i.Bootstrap {
			return conflict("%s is the control plane the Talos root bootstraps, or has no address; only a joining control plane installs", d.Name)
		}
	}
	if d.TPM == "" {
		return conflict("%s has no tpm_version; apply terraform/netbox/folly", d.Name)
	}
	if err := i.prepare(ctx); err != nil {
		return unavailable("the renderer: %v", err)
	}
	return nil
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
// config whole, and burns it once the node has acknowledged every byte of
// the answer. A HEAD, a conditional request or another method serves
// nothing; a Range is ignored, so the answer is always the whole file.
func (i *Installer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
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
	p, cfg, ok := i.Configs.Claim(uuid, code, now)
	if !ok {
		i.notFound(r.Context(), uuid, code, now)
		http.NotFound(w, r)
		return
	}
	// stays gives back a config the fetch did not deliver, and names what
	// became of it.
	stays := func() string {
		if i.Configs.Unclaim(uuid, code) {
			return "the config stays"
		}
		i.pending()
		return "the config was withdrawn during the fetch and is dropped"
	}
	if status := i.stillPlanned(r.Context(), p); status != http.StatusOK {
		if left := stays(); status == http.StatusServiceUnavailable {
			log.Printf("talos-config: %s's fetch got 503; %s", p.Node, left)
		}
		http.Error(w, http.StatusText(status), status)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/yaml")
	h.Set("Cache-Control", "no-store")
	h.Set("Content-Length", strconv.Itoa(len(cfg)))
	if err := armReset(r, true); err != nil {
		log.Printf("talos-config: %s's fetch: make a close a reset: %v", p.Node, err)
	}
	w.WriteHeader(http.StatusOK)
	n, err := w.Write(cfg)
	if err == nil {
		err = http.NewResponseController(w).Flush()
	}
	if err == nil && n != len(cfg) {
		err = io.ErrShortWrite
	}
	if err != nil {
		err = fmt.Errorf("the write ended after %d of %d bytes: %w", n, len(cfg), err)
	} else {
		// Write and Flush return once fleetd's kernel takes the bytes,
		// whether the node gets any of them or not.
		err = awaitAck(r, ackDeadline(r, start))
	}
	// A partial write and an unacknowledged answer end alike, whichever
	// comes first on a given network and socket buffer.
	if err != nil {
		err = resetConn(r, err)
		left := stays()
		log.Printf("talos-config: %s at %s did not acknowledge its config: %v; %s", p.Node, r.RemoteAddr, err, left)
		i.async(func(ctx context.Context) { i.unacked(ctx, p, r.RemoteAddr, now, err, left) })
		return
	}
	if err := armReset(r, false); err != nil {
		log.Printf("talos-config: %s's fetch: make a close graceful again: %v", p.Node, err)
	}
	served, ok := i.Configs.Burn(uuid, code, now)
	if !ok {
		log.Printf("talos-config: %s's config was replaced during the fetch, which served the old one", p.Node)
		return
	}
	log.Printf("served %s's config at %s; it is dropped", served.Node, timestamp(now))
	// The answer is complete, so the release runs after the handler: a slow
	// NetBox never holds the node's fetch, and a release that fails is
	// retried by the next pass.
	i.async(func(ctx context.Context) {
		i.releaseOnce(ctx, served)
		i.pending()
	})
}

// async runs a NetBox write after the handler; Drain waits for it.
func (i *Installer) async(f func(context.Context)) {
	i.inflight.Add(1)
	go func() {
		defer i.inflight.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		f(ctx)
	}()
}

// sentence capitalizes a log clause for a journal entry.
func sentence(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// unacked journals a fetch whose answer the node did not acknowledge: the
// config stays for the node's next try, unless it was withdrawn meanwhile,
// and the owner sees that a peer with the code got some of it.
func (i *Installer) unacked(ctx context.Context, p Pending, peer string, at time.Time, why error, left string) {
	d, err := i.NetBox.BySerial(ctx, i.Site, p.Serial)
	if err == nil {
		comment := fmt.Sprintf("fleetd: at %s fleetd wrote the Talos config to %s, and the peer did not acknowledge all of it: %v. %s", timestamp(at), peer, why, sentence(left))
		err = i.NetBox.Update(ctx, d, "", nil, "warning", comment)
	}
	if err != nil {
		log.Printf("journal %s's unacknowledged fetch: %v", p.Node, err)
	}
}

// stillPlanned reads the config's device from NetBox at fetch time and
// answers 200 only while it is planned, the status a render requires and the
// release moves on. A device that left planned, or that NetBox no longer
// holds, loses the config (404). A NetBox that does not answer keeps it and
// answers 503, and the node's next fetch tries again: the config carries the
// cluster's secrets, so the fetch fails closed.
func (i *Installer) stillPlanned(ctx context.Context, p Pending) int {
	ctx, cancel := context.WithTimeout(ctx, fetchLookup)
	defer cancel()
	d, err := i.NetBox.BySerial(ctx, i.Site, p.Serial)
	switch {
	case errors.Is(err, ErrNoDevice):
		i.Configs.Unclaim(p.UUID, p.Code)
		i.dropGone(p)
		return http.StatusNotFound
	case err != nil:
		log.Printf("talos-config: %s's fetch refused: NetBox does not answer: %v", p.Node, err)
		return http.StatusServiceUnavailable
	case d.Status != "planned":
		i.Configs.Unclaim(p.UUID, p.Code)
		if err := i.Withdraw(ctx, d); err != nil {
			log.Printf("journal the withdrawal of %s's config: %v", p.Node, err)
		}
		return http.StatusNotFound
	}
	return http.StatusOK
}

// fetchLookup bounds the NetBox read a fetch waits on.
const fetchLookup = 10 * time.Second

// WithdrawGone drops the unread configs whose device is not among NetBox's
// live devices: deleted, offline or moved off the site. Each pass calls it
// with a device list that is not empty.
func (i *Installer) WithdrawGone(devices []Device) {
	live := map[string]bool{}
	for _, d := range devices {
		live[strings.ToLower(d.Serial)] = true
	}
	for _, p := range i.Configs.Unread() {
		if !live[strings.ToLower(p.Serial)] {
			i.dropGone(p)
		}
	}
}

// dropGone drops the config of a device NetBox no longer holds, which has no
// journal to write to.
func (i *Installer) dropGone(p Pending) {
	_, fetching, ok := i.Configs.Drop(p.Serial, i.Now())
	if !ok {
		return
	}
	i.pending()
	d := Device{Serial: p.Serial, Name: p.Node, Class: p.Class}
	if fetching {
		Audit("fleet.expire", i.Site, d, p.Workflow, "withdrawn while a fetch writes it: NetBox no longer lists the device")
		log.Printf("talos-config: withdrew %s's config while a fetch was writing it, so the node may have it; NetBox no longer lists the device", p.Node)
		return
	}
	Audit("fleet.expire", i.Site, d, p.Workflow, "withdrawn: NetBox no longer lists the device")
	log.Printf("talos-config: dropped %s's unread config; NetBox no longer lists the device", p.Node)
}

// Drain waits for the releases that fetches started.
func (i *Installer) Drain() { i.inflight.Wait() }

// releaseOnce releases a served config unless another release of it runs.
func (i *Installer) releaseOnce(ctx context.Context, p Pending) {
	i.mu.Lock()
	if i.releasing == nil {
		i.releasing = map[string]bool{}
	}
	if i.releasing[p.Code] {
		i.mu.Unlock()
		return
	}
	i.releasing[p.Code] = true
	i.mu.Unlock()
	defer func() {
		i.mu.Lock()
		delete(i.releasing, p.Code)
		i.mu.Unlock()
	}()
	if err := i.release(ctx, p); err != nil {
		i.releaseFailed(ctx, p, err)
	}
}

// missingLookupEvery spaces the NetBox lookups that fetches for UUIDs with no
// config cause, across every UUID, since the endpoint is unauthenticated.
const missingLookupEvery = time.Second

// notFound journals a 404 the owner must act on, and logs any other. A
// fetch with a code other than the one rendered for the machine is
// journaled. So is a fetch for a machine fleetd holds no config for, when
// NetBox shows a planned device whose last run is a provision: a reboot of
// spore since the render, or the TTL, dropped its config, and the node asks
// in vain until the owner provisions it again. That one is counted on every
// lookup, so its alert lasts while the node asks, and journaled once per run.
// A machine causes at most one NetBox lookup per notFoundEvery, and all of
// them together one per missingLookupEvery, so a flood of guesses reaches
// NetBox at a bounded rate and the journal not at all. A fetch with the held
// code of a config past its TTL is the expiry's to journal. A fetch with a
// code fleetd served comes first: only a node that held the code can send
// it, and it is refetched's.
func (i *Installer) notFound(ctx context.Context, uuid, code string, now time.Time) {
	if s, ok := i.Configs.Served(uuid, code); ok {
		i.refetched(ctx, uuid, s, now)
		return
	}
	p, held := i.Configs.Holds(uuid)
	if held && p.Code == code {
		log.Printf("talos-config: 404 for uuid %q", uuid)
		return
	}
	if !i.lookupAllowed(uuid, held, now) {
		log.Printf("talos-config: 404 for uuid %q", uuid)
		return
	}
	var err error
	if held {
		err = i.otherCode(ctx, p, now)
	} else {
		err = i.missing(ctx, uuid, now)
	}
	if err != nil {
		log.Printf("talos-config: journal the 404 for uuid %q: %v", uuid, err)
		i.mu.Lock()
		delete(i.journaled, uuid)
		i.mu.Unlock()
	}
}

// refetched counts a fetch with a code whose config fleetd served, on every
// ask so the alert lasts while the node asks, and journals it once per run
// whatever the device's status. The node acknowledged the whole config and
// did not keep it, so it asks with a spent code until the owner provisions it
// again: fleetd never serves a config twice, since the code is a bearer
// credential that sits in META and on the node's console.
func (i *Installer) refetched(ctx context.Context, uuid string, s Served, now time.Time) {
	i.Metrics.ConfigRefetched.Add(1)
	key := uuid + "/" + s.Workflow
	i.mu.Lock()
	told := i.refetchTold[key]
	i.mu.Unlock()
	if told || !i.lookupAllowed("served/"+uuid, true, now) {
		log.Printf("talos-config: %s asked again for the config fleetd served it at %s", s.Node, timestamp(s.At))
		return
	}
	d, err := i.NetBox.BySerial(ctx, i.Site, s.Serial)
	if err == nil {
		Audit("fleet.refetch", i.Site, d, s.Workflow, "the node asked again for the config fleetd served it")
		comment := fmt.Sprintf("fleetd: at %s the node asked again for the Talos config fleetd served it at %s for Workflow %s. Its kernel acknowledged every byte, and the node did not keep it: a power loss or a reset before Talos wrote it to STATE. Its code is spent and fleetd serves no config twice, so the node asks in vain. Set desired_action to provision; the disk holds no STATE to lose", timestamp(now), timestamp(s.At), s.Workflow)
		err = i.NetBox.Update(ctx, d, "", nil, "warning", comment)
	}
	i.mu.Lock()
	defer i.mu.Unlock()
	if err != nil {
		log.Printf("talos-config: journal %s's ask for its served config: %v", s.Node, err)
		delete(i.journaled, "served/"+uuid)
		return
	}
	if i.refetchTold == nil {
		i.refetchTold = map[string]bool{}
	}
	i.refetchTold[key] = true
}

// lookupAllowed marks the machine's lookup unless one was made within
// notFoundEvery, or, for a UUID with no config, any was made within
// missingLookupEvery. The caller unmarks a lookup that failed.
func (i *Installer) lookupAllowed(uuid string, held bool, now time.Time) bool {
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.journaled == nil {
		i.journaled = map[string]time.Time{}
	}
	for k, t := range i.journaled {
		if now.Sub(t) >= notFoundEvery {
			delete(i.journaled, k)
		}
	}
	if _, recent := i.journaled[uuid]; recent {
		return false
	}
	if !held {
		if now.Sub(i.lastLookup) < missingLookupEvery {
			return false
		}
		i.lastLookup = now
	}
	i.journaled[uuid] = now
	return true
}

// otherCode journals a fetch with a code other than the held one.
func (i *Installer) otherCode(ctx context.Context, p Pending, now time.Time) error {
	d, err := i.NetBox.BySerial(ctx, i.Site, p.Serial)
	if err != nil {
		return err
	}
	comment := fmt.Sprintf("fleetd: at %s the node asked for its Talos config with a code other than the one rendered for it, and got 404", timestamp(now))
	return i.NetBox.Update(ctx, d, "", nil, "warning", comment)
}

// missing counts and journals a fetch by a planned device's node after its
// provision, for which fleetd holds no config. A UUID NetBox does not hold
// is only logged.
func (i *Installer) missing(ctx context.Context, uuid string, now time.Time) error {
	d, err := i.NetBox.BySMBIOSUUID(ctx, i.Site, uuid)
	if errors.Is(err, ErrNoDevice) {
		log.Printf("talos-config: 404 for uuid %q, which NetBox does not hold", uuid)
		return nil
	}
	if err != nil {
		return err
	}
	if d.Status != "planned" || !strings.HasPrefix(d.LastWorkflow, "provision-"+d.Name+"-") {
		log.Printf("talos-config: 404 for %s, which is %s with last_workflow %q", d.Name, d.Status, d.LastWorkflow)
		return nil
	}
	i.Metrics.ConfigMissing.Add(1)
	key := uuid + "/" + d.LastWorkflow
	i.mu.Lock()
	told := i.missingTold[key]
	i.mu.Unlock()
	if told {
		return nil
	}
	Audit("fleet.expire", i.Site, d, d.LastWorkflow, "config missing: the node asked for one fleetd does not hold")
	cause := fmt.Sprintf("a reboot of spore since the render of %s drops it, as does the TTL", d.LastWorkflow)
	for _, p := range i.Configs.Unreleased() {
		if p.UUID == uuid && p.Workflow == d.LastWorkflow {
			cause = fmt.Sprintf("fleetd served the config of %s at %s, NetBox has not taken its release, and the node did not keep it", p.Workflow, timestamp(p.Fetched))
		}
	}
	comment := fmt.Sprintf("fleetd: at %s the node asked for its Talos config, and fleetd holds none for it: %s. The node asks in vain and the device stays planned. Set desired_action to provision", timestamp(now), cause)
	if err := i.NetBox.Update(ctx, d, "", nil, "warning", comment); err != nil {
		return err
	}
	i.mu.Lock()
	if i.missingTold == nil {
		i.missingTold = map[string]bool{}
	}
	i.missingTold[key] = true
	i.mu.Unlock()
	return nil
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
		i.releaseOnce(ctx, p)
	}
	i.pending()
}

// release sets a device active once its config was served. A device the
// owner moved out of planned meanwhile keeps its status, and so does one
// whose config was withdrawn while the fetch wrote it.
func (i *Installer) release(ctx context.Context, p Pending) error {
	d, err := i.NetBox.BySerial(ctx, i.Site, p.Serial)
	if errors.Is(err, ErrNoDevice) && !p.Withdrawn.IsZero() {
		i.Configs.Released(p)
		Audit("fleet.release", i.Site, Device{Serial: p.Serial, Name: p.Node, Class: p.Class}, p.Workflow, "a withdrawn config fetched; NetBox no longer lists the device")
		return nil
	}
	if err != nil {
		return err
	}
	status, level := "active", "success"
	comment := fmt.Sprintf("fleetd: the node fetched its Talos config at %s; the device is active and the config is dropped", timestamp(p.Fetched))
	switch {
	case !p.Withdrawn.IsZero():
		status, level = "", "warning"
		comment = fmt.Sprintf("fleetd: the node fetched the config fleetd withdrew at %s; the fetch was writing it at the withdrawal and the node got all of it at %s. The status stays %s", timestamp(p.Withdrawn), timestamp(p.Fetched), d.Status)
	case d.Status != "planned":
		status = ""
		comment = fmt.Sprintf("fleetd: the node fetched its Talos config at %s and the config is dropped; the status stays %s", timestamp(p.Fetched), d.Status)
	}
	fields := map[string]any{"attest_consumed_at": timestamp(p.Fetched)}
	if err := i.NetBox.Update(ctx, d, status, fields, level, comment); err != nil {
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

// Withdraw drops the unread config of a device that is no longer planned and
// journals it, so a node the owner moved on, such as one being retired, never
// fetches the cluster's secrets. Each reconcile pass calls it.
func (i *Installer) Withdraw(ctx context.Context, d Device) error {
	if d.Status == "planned" {
		return nil
	}
	p, fetching, ok := i.Configs.Drop(d.Serial, i.Now())
	if !ok {
		return nil
	}
	i.pending()
	if fetching {
		Audit("fleet.expire", i.Site, d, p.Workflow, "withdrawn while a fetch writes it: the device is "+d.Status)
		comment := fmt.Sprintf("fleetd: the device is %s; a fetch was writing its Talos config, rendered at %s for Workflow %s, so the node may have it. fleetd journals the fetch's end if the node got all of it", d.Status, timestamp(p.Rendered), p.Workflow)
		return i.NetBox.Update(ctx, d, "", nil, "warning", comment)
	}
	Audit("fleet.expire", i.Site, d, p.Workflow, "withdrawn: the device is "+d.Status)
	comment := fmt.Sprintf("fleetd: the device is %s, so fleetd dropped the Talos config rendered at %s for Workflow %s before the node fetched it; the node gets no config", d.Status, timestamp(p.Rendered), p.Workflow)
	return i.NetBox.Update(ctx, d, "", nil, "warning", comment)
}

// pending refreshes the counts and oldest times of the unread configs and
// of the served ones NetBox has no release for.
func (i *Installer) pending() {
	unread, oldestUnread, unreleased, oldestUnreleased := i.Configs.Stats()
	i.Metrics.SetPending(unread, oldestUnread, unreleased, oldestUnreleased)
}
