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
// and the worker secrets, and writes it where nginx serves
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
	// TailInterval is how often Run reads nginx's log.
	TailInterval time.Duration
	Metrics      *Metrics
	Now          func() time.Time

	mu       sync.Mutex
	prepared bool
	seen404  map[string]bool
}

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
		reply(w, ref.status, ref.reason)
	default:
		i.Metrics.RenderFailed.Add(1)
		log.Printf("render %s: %v", req.Serial, err)
		reply(w, http.StatusServiceUnavailable, "the render failed; the controller's journal says why")
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
	if d.Status != "planned" && d.Status != "staged" {
		return d, conflict("%s is %s; only a planned or staged device installs", d.Name, d.Status)
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
	switch i.Renderer.MachineType(d.Class) {
	case "":
		return d, unavailable("the class inputs have no class %q", d.Class)
	case "controlplane":
		return d, conflict("%s is a control plane, which the owner renders", d.Name)
	}
	if err := i.prepare(ctx); err != nil {
		return d, unavailable("the renderer: %v", err)
	}
	cfg, err := i.Renderer.Render(ctx, Node{Name: d.Name, Class: d.Class, Disk: d.Disk, TPM: d.TPM})
	if err != nil {
		return d, unavailable("render %s: %v", d.Name, err)
	}
	p := Pending{
		UUID: req.UUID, Code: req.Code, Serial: d.Serial, Node: d.Name, Class: d.Class,
		Workflow: d.LastWorkflow, Rendered: i.Now(),
	}
	if err := i.Store.Put(p, cfg); err != nil {
		return d, unavailable("write the config: %v", err)
	}
	i.pending()
	comment := fmt.Sprintf("fleet-controller: rendered the %s config for %s's install; it is deleted when the node fetches it on its first boot, or unread after %s", d.Class, d.Name, i.TTL)
	if err := i.NetBox.Update(ctx, d, "", nil, "info", comment); err != nil {
		log.Printf("journal the render of %s: %v", d.Name, err)
	}
	return d, nil
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
		switch f.Status {
		case http.StatusOK:
			p, ok, err := i.Store.Served(f.UUID, f.Code, f.At)
			if err != nil {
				log.Printf("burn %s: %v", f.UUID, err)
				continue
			}
			if !ok {
				continue
			}
			served = true
			log.Printf("nginx served %s's config at %s; the file is deleted", p.Node, timestamp(f.At))
		case http.StatusNotFound:
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

// notFound journals a 404 once per code on the device the UUID names: a
// wrong code, an expired one, or one already spent.
func (i *Installer) notFound(ctx context.Context, f Fetch) {
	key := f.UUID + "/" + f.Code
	i.mu.Lock()
	if i.seen404 == nil || len(i.seen404) > 1000 {
		i.seen404 = map[string]bool{}
	}
	seen := i.seen404[key]
	i.seen404[key] = true
	i.mu.Unlock()
	if seen {
		return
	}
	if !uuidPattern.MatchString(f.UUID) {
		log.Printf("talos-config: 404 for a malformed uuid %q", f.UUID)
		return
	}
	d, err := i.NetBox.BySMBIOSUUID(ctx, i.Site, f.UUID)
	if err != nil {
		log.Printf("talos-config: 404 for uuid %s, which names no device: %v", f.UUID, err)
		return
	}
	comment := fmt.Sprintf("fleet-controller: at %s the node asked for its Talos config with an install code the controller does not hold (wrong, expired or already used); nginx answered 404", timestamp(f.At))
	if err := i.NetBox.Update(ctx, d, "", nil, "warning", comment); err != nil {
		log.Printf("journal the 404 of %s: %v", d.Name, err)
		i.mu.Lock()
		delete(i.seen404, key)
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
		case !p.Fetched.IsZero():
			if err := i.release(ctx, p); err != nil {
				log.Printf("release %s: %v", p.Node, err)
				if now.Sub(p.Fetched) > i.TTL {
					log.Printf("%s's release is older than %s; its record is dropped", p.Node, i.TTL)
					_ = i.Store.Drop(p)
				}
			}
		case now.Sub(p.Rendered) > i.TTL:
			if err := i.expire(ctx, p); err != nil {
				log.Printf("expire %s: %v", p.Node, err)
			}
		}
	}
	if err := i.Store.Strays(now, i.TTL); err != nil {
		log.Printf("talos configs: %v", err)
	}
	i.pending()
}

// release sets a device active once its config was served. A device the
// owner moved out of planned or staged meanwhile keeps its status.
func (i *Installer) release(ctx context.Context, p Pending) error {
	d, err := i.NetBox.BySerial(ctx, i.Site, p.Serial)
	if err != nil {
		return err
	}
	status := "active"
	comment := fmt.Sprintf("fleet-controller: the node fetched its Talos config at %s; the device is active and the file is deleted", timestamp(p.Fetched))
	if d.Status != "planned" && d.Status != "staged" {
		status = ""
		comment = fmt.Sprintf("fleet-controller: the node fetched its Talos config at %s and the file is deleted; the status stays %s", timestamp(p.Fetched), d.Status)
	}
	fields := map[string]any{"attest_consumed_at": timestamp(p.Fetched)}
	if err := i.NetBox.Update(ctx, d, status, fields, "success", comment); err != nil {
		return err
	}
	if err := i.Store.Drop(p); err != nil {
		return err
	}
	i.Metrics.Released.Add(1)
	if status != "" {
		d.Status = status
	}
	Audit("fleet.release", i.Site, d, p.Workflow, "config fetched")
	return nil
}

func (i *Installer) expire(ctx context.Context, p Pending) error {
	if err := i.Store.Drop(p); err != nil {
		return err
	}
	i.Metrics.Expired.Add(1)
	d := Device{Serial: p.Serial, Name: p.Node, Class: p.Class}
	Audit("fleet.expire", i.Site, d, p.Workflow, "config unread after "+i.TTL.String())
	found, err := i.NetBox.BySerial(ctx, i.Site, p.Serial)
	if err != nil {
		return err
	}
	comment := fmt.Sprintf("fleet-controller: the Talos config rendered at %s was not fetched within %s and is deleted; provision the node again", timestamp(p.Rendered), i.TTL)
	return i.NetBox.Update(ctx, found, "", nil, "warning", comment)
}

// pending refreshes the count and the oldest render time of unread configs.
func (i *Installer) pending() {
	records, err := i.Store.Records()
	if err != nil {
		return
	}
	n := 0
	var oldest time.Time
	for _, p := range records {
		if !p.Fetched.IsZero() {
			continue
		}
		n++
		if oldest.IsZero() || p.Rendered.Before(oldest) {
			oldest = p.Rendered
		}
	}
	i.Metrics.SetPending(n, oldest)
}
