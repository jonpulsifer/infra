package fleet

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

type fakeRenderer struct {
	types map[string]string
	calls int
}

func (f *fakeRenderer) Classes() []string               { return nil }
func (f *fakeRenderer) MachineType(class string) string { return f.types[class] }
func (f *fakeRenderer) Render(_ context.Context, n Node) ([]byte, error) {
	f.calls++
	return []byte("machine:\n  type: worker\n# " + n.Name + " " + n.Disk + " " + n.TPM + "\n"), nil
}

const (
	testUUID = "4c4c4544-0042-3510-8051-b4c04f565432"
	testCode = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde"
	provWF   = "provision-riptide-1700000000"
)

type installTest struct {
	in   *Installer
	nb   *fakeNetBox
	kube *fakeKube
	rend *fakeRenderer
	now  time.Time
}

func newInstallTest(t *testing.T, status string, cf map[string]any) *installTest {
	t.Helper()
	if cf == nil {
		cf = map[string]any{}
	}
	if _, ok := cf["last_workflow"]; !ok {
		cf["last_workflow"] = provWF
	}
	cf["smbios_uuid"] = testUUID
	nb := &fakeNetBox{devices: []map[string]any{device("riptide", status, "none", cf)}, ifaces: riptideIfaces()}
	wf := workflowObject(provWF, "riptide", "provision", "2023-11-14T22:13:20Z", "STATE_RUNNING")
	wf["spec"] = map[string]any{"hardwareMap": map[string]any{"install": "true"}}
	kube := &fakeKube{objects: map[string]Object{wfBase + provWF: wf}}
	nbs := httptest.NewServer(nb.handler())
	ks := httptest.NewServer(kube.handler())
	t.Cleanup(func() { nbs.Close(); ks.Close() })
	it := &installTest{nb: nb, kube: kube, now: testNow}
	it.rend = &fakeRenderer{types: map[string]string{"worker-g5": "worker", "controlplane": "controlplane"}}
	it.in = &Installer{
		Site:     "folly",
		NetBox:   &NetBox{URL: nbs.URL, Token: "nbt_x.y", Client: nbs.Client()},
		Kube:     &Kube{Server: ks.URL, Namespace: "tinkerbell", Client: ks.Client()},
		Renderer: it.rend,
		Configs:  &Configs{},
		TTL:      2 * time.Hour,
		Metrics:  NewMetrics(),
		Now:      func() time.Time { return it.now },
	}
	return it
}

// status maps a render's outcome to the code the old HTTP contract used:
// 201 rendered, 409 refused by the device's state, 503 not possible now.
func status(err error) int {
	var ref *refusal
	switch {
	case err == nil:
		return http.StatusCreated
	case errors.As(err, &ref):
		return ref.status
	}
	return http.StatusInternalServerError
}

func (it *installTest) render(req RenderRequest) (int, string) {
	err := it.in.Render(context.Background(), req)
	if err == nil {
		return http.StatusCreated, ""
	}
	return status(err), err.Error()
}

func goodRequest() RenderRequest {
	return RenderRequest{Serial: "MXL0172Q6L", UUID: testUUID, Node: "riptide", Class: "worker-g5", Code: testCode}
}

// fetch is the node's GET of its config.
func (it *installTest) fetch(method, uuid, code string, header map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "/talos/config?uuid="+uuid+"&code="+code, nil)
	for k, v := range header {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	it.in.ServeHTTP(w, r)
	it.in.Drain()
	return w
}

func (it *installTest) held(code string) bool {
	_, cfg, ok := it.in.Configs.Get(testUUID, code, it.now)
	return ok && len(cfg) > 0
}

func TestRenderRefusesAMalformedRequest(t *testing.T) {
	it := newInstallTest(t, "planned", nil)
	for _, mut := range []func(*RenderRequest){
		func(r *RenderRequest) { r.UUID = strings.ToUpper(testUUID) },
		func(r *RenderRequest) { r.Code = "../../etc/passwd" },
		func(r *RenderRequest) { r.Serial = "" },
	} {
		req := goodRequest()
		mut(&req)
		if code, _ := it.render(req); code != http.StatusConflict {
			t.Errorf("%+v: %d", req, code)
		}
	}
	if it.rend.calls != 0 {
		t.Fatal("a malformed request rendered")
	}
}

func TestRenderGates(t *testing.T) {
	cases := []struct {
		name   string
		status string
		cf     map[string]any
		req    func(*RenderRequest)
		kube   func(*fakeKube)
		want   int
	}{
		{name: "unknown serial", status: "planned", req: func(r *RenderRequest) { r.Serial = "NOPE" }, want: 409},
		{name: "active device", status: "active", want: 409},
		{name: "failed device", status: "failed", want: 409},
		{name: "attest run", status: "planned", cf: map[string]any{"last_workflow": "attest-riptide-1700000000"}, want: 409},
		{name: "no run", status: "planned", cf: map[string]any{"last_workflow": nil}, want: 409},
		{name: "another node's run", status: "planned", cf: map[string]any{"last_workflow": "provision-swell-1700000000"}, want: 409},
		{name: "run finished", status: "planned", kube: func(k *fakeKube) { k.setState(provWF, "STATE_SUCCESS") }, want: 409},
		{name: "run gone", status: "planned", kube: func(k *fakeKube) { delete(k.objects, wfBase+provWF) }, want: 409},
		{name: "control plane", status: "planned", cf: map[string]any{"talos_class": "controlplane"}, req: func(r *RenderRequest) { r.Class = "controlplane" }, want: 409},
		{name: "node mismatch", status: "planned", req: func(r *RenderRequest) { r.Node = "swell" }, want: 409},
		{name: "class mismatch", status: "planned", req: func(r *RenderRequest) { r.Class = "worker-g2" }, want: 409},
		{name: "class without inputs", status: "planned", cf: map[string]any{"talos_class": "worker-g9"}, req: func(r *RenderRequest) { r.Class = "worker-g9" }, want: 503},
		{name: "another SMBIOS UUID", status: "planned", req: func(r *RenderRequest) { r.UUID = "00000000-0000-0000-0000-000000000000" }, want: 409},
		{name: "a run that installs nothing", status: "planned", kube: func(k *fakeKube) {
			k.objects[wfBase+provWF]["spec"] = map[string]any{"hardwareMap": map[string]any{"install": "false"}}
		}, want: 409},
		{name: "a run without a hardware map", status: "planned", kube: func(k *fakeKube) { delete(k.objects[wfBase+provWF], "spec") }, want: 409},
		{name: "planned", status: "planned", want: 201},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			it := newInstallTest(t, c.status, c.cf)
			if c.kube != nil {
				c.kube(it.kube)
			}
			req := goodRequest()
			if c.req != nil {
				c.req(&req)
			}
			code, reason := it.render(req)
			if code != c.want {
				t.Fatalf("answered %d (%s), want %d", code, reason, c.want)
			}
			if (c.want == 201) != it.held(req.Code) {
				t.Fatalf("answered %d, and the config is held: %v", code, it.held(req.Code))
			}
			if c.want != 201 && reason == "" {
				t.Fatal("a refusal without a reason")
			}
			if strings.Contains(reason, testCode) {
				t.Fatalf("the reason carries the code: %s", reason)
			}
		})
	}
}

func TestRenderKeepsOneConfigPerMachine(t *testing.T) {
	it := newInstallTest(t, "planned", nil)
	if code, reason := it.render(goodRequest()); code != 201 {
		t.Fatalf("%d %s", code, reason)
	}
	_, cfg, ok := it.in.Configs.Get(testUUID, testCode, it.now)
	if !ok || !strings.Contains(string(cfg), "riptide /dev/nvme0n1 2.0") {
		t.Fatalf("the config: %q %v", cfg, ok)
	}
	if it.in.Metrics.Rendered.Load() != 1 || it.in.Metrics.pending != 1 {
		t.Fatal("the render went uncounted")
	}
	// A new code for the same machine replaces the old one, which is spent.
	req := goodRequest()
	req.Code = strings.Repeat("Z", 43)
	if code, _ := it.render(req); code != 201 {
		t.Fatal(code)
	}
	if it.held(testCode) || !it.held(req.Code) || !it.in.Configs.Spent(testUUID, testCode) {
		t.Fatal("the older code's config survived a new render")
	}
	if w := it.fetch(http.MethodGet, testUUID, testCode, nil); w.Code != http.StatusNotFound {
		t.Fatalf("the replaced code answered %d", w.Code)
	}
}

func lastPatch(nb *fakeNetBox) map[string]any {
	nb.mu.Lock()
	defer nb.mu.Unlock()
	if len(nb.patches) == 0 {
		return nil
	}
	return nb.patches[len(nb.patches)-1]
}

func journalCount(nb *fakeNetBox, kind string) int {
	nb.mu.Lock()
	defer nb.mu.Unlock()
	n := 0
	for _, j := range nb.journals {
		if j["kind"] == kind {
			n++
		}
	}
	return n
}

func TestServedConfigIsBurnedAndTheDeviceGoesActive(t *testing.T) {
	it := newInstallTest(t, "planned", nil)
	if code, _ := it.render(goodRequest()); code != 201 {
		t.Fatal(code)
	}
	w := it.fetch(http.MethodGet, testUUID, testCode, nil)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "riptide") || w.Header().Get("Cache-Control") != "no-store" ||
		w.Header().Get("Content-Length") != strconv.Itoa(w.Body.Len()) || w.Header().Get("Accept-Ranges") != "" {
		t.Fatalf("the fetch: %d %v %q", w.Code, w.Header(), w.Body.String())
	}
	p := lastPatch(it.nb)
	if p == nil || p["status"] != "active" || p["custom_fields"].(map[string]any)["attest_consumed_at"] != "2023-11-14T22:13:20Z" {
		t.Fatalf("the release patch: %v", p)
	}
	if journalCount(it.nb, "success") != 1 || it.in.Metrics.Released.Load() != 1 || len(it.in.Configs.Unreleased()) != 0 {
		t.Fatal("the release was not journaled once")
	}
	// Served once: a second fetch is a 404, and a render under the code is refused.
	if w := it.fetch(http.MethodGet, testUUID, testCode, nil); w.Code != http.StatusNotFound {
		t.Fatalf("a second fetch answered %d", w.Code)
	}
	it.nb.set("status", map[string]any{"value": "planned"})
	if code, reason := it.render(goodRequest()); code != http.StatusConflict {
		t.Fatalf("a replayed render: %d %s", code, reason)
	}
	if it.held(testCode) {
		t.Fatal("a replayed render brought the config back")
	}
}

// Only a whole GET serves and burns: HEAD and other methods are refused, a
// conditional request is refused, and a Range is ignored.
func TestOnlyAWholeGetBurns(t *testing.T) {
	it := newInstallTest(t, "planned", nil)
	if code, _ := it.render(goodRequest()); code != 201 {
		t.Fatal(code)
	}
	for _, m := range []string{http.MethodHead, http.MethodPost, http.MethodPut} {
		if w := it.fetch(m, testUUID, testCode, nil); w.Code != http.StatusMethodNotAllowed || w.Body.Len() > 0 && strings.Contains(w.Body.String(), "riptide") {
			t.Fatalf("%s answered %d", m, w.Code)
		}
	}
	for _, h := range []map[string]string{{"If-None-Match": `"x"`}, {"If-Modified-Since": "Tue, 14 Nov 2023 22:13:20 GMT"}} {
		if w := it.fetch(http.MethodGet, testUUID, testCode, h); w.Code != http.StatusBadRequest {
			t.Fatalf("%v answered %d", h, w.Code)
		}
	}
	// A write that fails part way serves nothing.
	r := httptest.NewRequest(http.MethodGet, "/talos/config?uuid="+testUUID+"&code="+testCode, nil)
	it.in.ServeHTTP(&brokenWriter{ResponseRecorder: httptest.NewRecorder()}, r)
	if !it.held(testCode) {
		t.Fatal("a HEAD, a conditional request or a broken write burned the config")
	}
	w := it.fetch(http.MethodGet, testUUID, testCode, map[string]string{"Range": "bytes=0-3"})
	if w.Code != http.StatusOK || w.Header().Get("Content-Range") != "" || !strings.Contains(w.Body.String(), "riptide") {
		t.Fatalf("a ranged GET: %d %v", w.Code, w.Header())
	}
	if it.held(testCode) {
		t.Fatal("a whole GET did not burn")
	}
}

// brokenWriter stands for a connection that drops while the body goes out.
type brokenWriter struct{ *httptest.ResponseRecorder }

func (b *brokenWriter) Write(p []byte) (int, error) {
	return len(p) / 2, errors.New("connection reset")
}

func TestFailedReleaseIsKeptAndJournaledOnce(t *testing.T) {
	it := newInstallTest(t, "planned", nil)
	if code, _ := it.render(goodRequest()); code != 201 {
		t.Fatal(code)
	}
	ctx := context.Background()
	it.nb.failPatch = true
	if w := it.fetch(http.MethodGet, testUUID, testCode, nil); w.Code != http.StatusOK {
		t.Fatal(w.Code)
	}
	for k := 0; k < 3; k++ {
		it.now = it.now.Add(3 * time.Hour)
		it.in.Tick(ctx)
	}
	if u := it.in.Configs.Unreleased(); len(u) != 1 || u[0].Fetched.IsZero() {
		t.Fatalf("a release NetBox refused was dropped: %+v", u)
	}
	if n := journalCount(it.nb, "danger"); n != 1 {
		t.Fatalf("%d failure journal entries, want 1", n)
	}
	if it.in.Metrics.unreleased != 1 || it.in.Metrics.pending != 0 {
		t.Fatalf("unreleased %d, pending %d", it.in.Metrics.unreleased, it.in.Metrics.pending)
	}
	it.nb.failPatch = false
	it.in.Tick(ctx)
	if p := lastPatch(it.nb); p == nil || p["status"] != "active" {
		t.Fatalf("the retried release: %v", p)
	}
	if it.in.Metrics.unreleased != 0 || len(it.in.Configs.Unreleased()) != 0 {
		t.Fatal("the gauge kept a released config")
	}
	it.in.Tick(ctx)
	if journalCount(it.nb, "success") != 1 {
		t.Fatal("the release was repeated")
	}
}

func TestNotFoundIsJournaledOnlyForAHeldMachineAndRateLimited(t *testing.T) {
	it := newInstallTest(t, "planned", nil)
	other := "00000000-0000-0000-0000-000000000000"
	wrong := strings.Repeat("W", 43)
	// Nothing is held: a 404 reaches neither NetBox nor the journal.
	pages := it.nb.pages
	it.fetch(http.MethodGet, testUUID, wrong, nil)
	it.fetch(http.MethodGet, "-", "-", nil)
	if it.nb.pages != pages || journalCount(it.nb, "warning") != 0 {
		t.Fatal("a 404 for a machine with no config reached NetBox")
	}
	if code, _ := it.render(goodRequest()); code != 201 {
		t.Fatal(code)
	}
	for _, f := range [][2]string{{testUUID, wrong}, {testUUID, strings.Repeat("V", 43)}, {other, wrong}} {
		if w := it.fetch(http.MethodGet, f[0], f[1], nil); w.Code != http.StatusNotFound {
			t.Fatalf("%v answered %d", f, w.Code)
		}
	}
	if n := journalCount(it.nb, "warning"); n != 1 {
		t.Fatalf("%d 404 journal entries, want 1", n)
	}
	it.now = it.now.Add(notFoundEvery)
	it.fetch(http.MethodGet, testUUID, wrong, nil)
	if n := journalCount(it.nb, "warning"); n != 2 {
		t.Fatalf("%d 404 journal entries after the window, want 2", n)
	}
	if len(it.in.journaled) != 1 {
		t.Fatalf("the rate limit kept %d entries", len(it.in.journaled))
	}
	if !it.held(testCode) {
		t.Fatal("a wrong code burned the config")
	}
}

func TestUnreadConfigExpires(t *testing.T) {
	it := newInstallTest(t, "planned", nil)
	// A worker's config keeps the TTL beside the shorter control-plane one.
	it.in.ControlPlaneTTL = 30 * time.Minute
	if code, _ := it.render(goodRequest()); code != 201 {
		t.Fatal(code)
	}
	ctx := context.Background()
	it.now = testNow.Add(time.Hour)
	it.in.Tick(ctx)
	if !it.held(testCode) || it.in.Metrics.pending != 1 {
		t.Fatal("a config younger than the TTL expired")
	}
	it.now = testNow.Add(2*time.Hour + time.Second)
	if w := it.fetch(http.MethodGet, testUUID, testCode, nil); w.Code != http.StatusNotFound {
		t.Fatalf("an expired config answered %d", w.Code)
	}
	it.in.Tick(ctx)
	if journalCount(it.nb, "warning") != 1 || it.in.Metrics.Expired.Load() != 1 || it.in.Metrics.pending != 0 {
		t.Fatal("the expiry was not journaled and counted")
	}
	if p := lastPatch(it.nb); p != nil {
		t.Fatalf("an expiry changed the device: %v", p)
	}
	if code, _ := it.render(goodRequest()); code != http.StatusConflict {
		t.Fatal("an expired code rendered again")
	}
}

func TestReleaseLeavesAStatusTheOwnerChanged(t *testing.T) {
	it := newInstallTest(t, "planned", nil)
	if code, _ := it.render(goodRequest()); code != 201 {
		t.Fatal(code)
	}
	it.nb.failPatches(true)
	if w := it.fetch(http.MethodGet, testUUID, testCode, nil); w.Code != http.StatusOK {
		t.Fatal(w.Code)
	}
	it.nb.set("status", map[string]any{"value": "decommissioning"})
	it.nb.failPatches(false)
	it.in.Tick(context.Background())
	p := lastPatch(it.nb)
	if p == nil || p["status"] != nil || p["custom_fields"] == nil {
		t.Fatalf("the release patch: %v", p)
	}
}

// A fetch reads the device from NetBox and is served only while the device
// is planned. A device that left planned or that NetBox no longer holds loses
// its config; a NetBox that does not answer keeps it, and the fetch fails
// closed with 503 for the node to try again.
func TestAFetchServesOnlyAPlannedDevice(t *testing.T) {
	t.Run("decommissioning", func(t *testing.T) {
		it := newInstallTest(t, "planned", nil)
		if code, _ := it.render(goodRequest()); code != 201 {
			t.Fatal(code)
		}
		it.nb.set("status", map[string]any{"value": "decommissioning"})
		if w := it.fetch(http.MethodGet, testUUID, testCode, nil); w.Code != http.StatusNotFound {
			t.Fatalf("a decommissioning node fetched its config: %d", w.Code)
		}
		if it.held(testCode) || !it.in.Configs.Spent(testUUID, testCode) {
			t.Fatal("the config was not dropped and burned")
		}
		if len(it.nb.journalWith("the device is decommissioning, so fleetd dropped the Talos config")) != 1 {
			t.Fatalf("journals %v", it.nb.journals)
		}
	})
	t.Run("NetBox down", func(t *testing.T) {
		it := newInstallTest(t, "planned", nil)
		if code, _ := it.render(goodRequest()); code != 201 {
			t.Fatal(code)
		}
		down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "down", http.StatusBadGateway)
		}))
		defer down.Close()
		good := it.in.NetBox
		it.in.NetBox = &NetBox{URL: down.URL, Token: "nbt_x.y", Client: down.Client()}
		if w := it.fetch(http.MethodGet, testUUID, testCode, nil); w.Code != http.StatusServiceUnavailable {
			t.Fatalf("a fetch NetBox could not vouch for answered %d", w.Code)
		}
		if !it.held(testCode) {
			t.Fatal("the config was dropped while NetBox was down")
		}
		it.in.NetBox = good
		if w := it.fetch(http.MethodGet, testUUID, testCode, nil); w.Code != http.StatusOK {
			t.Fatalf("the retry answered %d", w.Code)
		}
	})
	t.Run("gone from NetBox", func(t *testing.T) {
		it := newInstallTest(t, "planned", nil)
		if code, _ := it.render(goodRequest()); code != 201 {
			t.Fatal(code)
		}
		it.nb.mu.Lock()
		it.nb.devices = nil
		it.nb.mu.Unlock()
		if w := it.fetch(http.MethodGet, testUUID, testCode, nil); w.Code != http.StatusNotFound {
			t.Fatalf("a deleted device's node fetched its config: %d", w.Code)
		}
		if it.held(testCode) || !it.in.Configs.Spent(testUUID, testCode) {
			t.Fatal("the config was not dropped and burned")
		}
	})
}

// A pass drops the unread config of a device NetBox no longer lists among its
// live devices, such as one deleted or set offline.
func TestAPassWithdrawsTheConfigOfAGoneDevice(t *testing.T) {
	it := newInstallTest(t, "planned", nil)
	if code, _ := it.render(goodRequest()); code != 201 {
		t.Fatal(code)
	}
	it.in.WithdrawGone([]Device{{Serial: "mxl0172q6l"}})
	if !it.held(testCode) {
		t.Fatal("a listed device's config was dropped")
	}
	it.in.WithdrawGone([]Device{{Serial: "OTHER"}})
	if it.held(testCode) || !it.in.Configs.Spent(testUUID, testCode) {
		t.Fatal("a gone device's config was kept")
	}
}

func TestWorkflowInstallsOnlyARenderedProvision(t *testing.T) {
	cfg := Config{Classes: testClasses,
		Installs: map[string]string{"worker-g5": "ghcr.io/jonpulsifer/talos-installer-folly:v1.14.4"}}
	hm := func(d Device, action string) map[string]any {
		d.DiskSerial = "30DF7020FGKL"
		return mustWorkflow(t, cfg, d, action)["spec"].(map[string]any)["hardwareMap"].(map[string]any)
	}
	g5 := Device{Name: "riptide", Class: "worker-g5", TPM: "2.0", Status: "planned", BMCType: "none"}
	if m := hm(g5, "provision"); m["install"] != "true" || m["installer_image"] != "ghcr.io/jonpulsifer/talos-installer-folly:v1.14.4" {
		t.Fatalf("a worker provision: %v", m)
	}
	for _, action := range []string{"attest", "wipe", ActionRetire} {
		if m := hm(g5, action); m["install"] != "false" || m["installer_image"] != "" {
			t.Errorf("%s installs: %v", action, m)
		}
	}
	for _, d := range []Device{
		{Name: "optiplex", Class: "controlplane", TPM: "2.0", BMCType: "none"},
		{Name: "shale", Class: "worker-g2", TPM: "1.2", BMCType: "none"},
	} {
		if m := hm(d, "provision"); m["install"] != "false" {
			t.Errorf("%s installs: %v", d.Name, m)
		}
	}
	cfg.Installs["controlplane"], cfg.Bootstrap = "ghcr.io/jonpulsifer/talos-installer-folly:v1.14.4", "10.3.0.10"
	if m := hm(Device{Name: "optiplex", Class: "controlplane", TPM: "2.0", Address: "10.3.0.10"}, "provision"); m["install"] != "false" {
		t.Errorf("the bootstrap control plane installs: %v", m)
	}
	if m := hm(Device{Name: "swell", Class: "controlplane", TPM: "2.0", Address: "10.3.0.14"}, "provision"); m["install"] != "true" {
		t.Errorf("a joining control plane installs nothing: %v", m)
	}
	// The render refuses a control plane with no address, so its run installs
	// nothing either; a worker's address plays no part.
	if m := hm(Device{Name: "swell", Class: "controlplane", TPM: "2.0"}, "provision"); m["install"] != "false" {
		t.Errorf("a control plane with no address installs: %v", m)
	}
	cfg.Installs["cp-g5"], cfg.ControlPlaneClasses = "ghcr.io/jonpulsifer/talos-installer-folly:v1.14.4", map[string]bool{"cp-g5": true}
	if m := hm(Device{Name: "swell", Class: "cp-g5", TPM: "2.0"}, "provision"); m["install"] != "false" {
		t.Errorf("a control-plane class of another name with no address installs: %v", m)
	}
	if m := hm(Device{Name: "riptide", Class: "worker-g5", TPM: "2.0"}, "provision"); m["install"] != "true" {
		t.Errorf("a worker with no address installs nothing: %v", m)
	}
	cfg.Installs = nil
	if m := hm(g5, "provision"); m["install"] != "false" {
		t.Errorf("a fleet without a renderer installs: %v", m)
	}
}

func controlPlaneTest(t *testing.T) (*installTest, RenderRequest) {
	it := newInstallTest(t, "planned", map[string]any{"talos_class": "controlplane"})
	req := goodRequest()
	req.Class = "controlplane"
	return it, req
}

func TestControlPlaneRendersOnlyBehindTheGate(t *testing.T) {
	it, req := controlPlaneTest(t)
	if code, reason := it.render(req); code != http.StatusConflict || !strings.Contains(reason, "the owner renders") {
		t.Fatalf("a control plane without the bundle: %d %s", code, reason)
	}
	it.in.ControlPlanes = true
	it.in.Bootstrap = "10.3.0.12"
	if code, _ := it.render(req); code != http.StatusConflict {
		t.Fatalf("the bootstrap control plane: %d", code)
	}
	it.in.Bootstrap = "10.3.0.10"
	it.nb.devices[0]["primary_ip4"] = nil
	if code, _ := it.render(req); code != http.StatusConflict {
		t.Fatalf("a control plane with no address: %d", code)
	}
	if it.rend.calls != 0 {
		t.Fatal("a refused control plane rendered")
	}
	it.nb.devices[0]["primary_ip4"] = map[string]any{"address": "10.3.0.12/26"}
	if code, reason := it.render(req); code != http.StatusCreated {
		t.Fatalf("a joining control plane: %d %s", code, reason)
	}
}

func TestControlPlaneConfigExpiresSooner(t *testing.T) {
	it, req := controlPlaneTest(t)
	it.in.ControlPlanes, it.in.Bootstrap, it.in.ControlPlaneTTL = true, "10.3.0.10", 30*time.Minute
	if code, _ := it.render(req); code != http.StatusCreated {
		t.Fatal(code)
	}
	ctx := context.Background()
	it.now = testNow.Add(29 * time.Minute)
	it.in.Tick(ctx)
	if !it.held(testCode) {
		t.Fatal("a control plane's config younger than its TTL expired")
	}
	it.now = testNow.Add(30*time.Minute + time.Second)
	it.in.Tick(ctx)
	if _, ok := it.in.Configs.Holds(testUUID); ok {
		t.Fatal("a control plane's config outlived its TTL")
	}
	if it.in.Metrics.Expired.Load() != 1 || journalCount(it.nb, "warning") != 1 {
		t.Fatal("the expiry was not journaled and counted")
	}
}

func TestLoadInstallerGatesControlPlanes(t *testing.T) {
	dir := t.TempDir()
	classes := filepath.Join(dir, "class-inputs.json")
	raw, _ := json.Marshal(riptideInputs())
	_ = os.WriteFile(classes, raw, 0o600)
	workers := filepath.Join(dir, "worker-secrets")
	_ = os.WriteFile(workers, []byte(fakeBundle("A")), 0o600)
	bundle := filepath.Join(dir, "bundle")
	_ = os.WriteFile(bundle, []byte(fullFakeBundle("A")), 0o600)
	t.Setenv("FLEET_CLASS_INPUTS", classes)
	t.Setenv("FLEET_WORKER_SECRETS", workers)
	t.Setenv("FLEET_TALOSCTL", "/bin/false")
	t.Setenv("FLEET_INSTALLS", "true")
	t.Setenv("FLEET_CONTROLPLANE_BUNDLE", "")
	t.Setenv("FLEET_BOOTSTRAP_ADDRESS", "")

	cfg := Config{}
	in, err := LoadInstaller(&cfg, nil, nil, NewMetrics())
	if err != nil || in.ControlPlanes || cfg.Installs["controlplane"] != "" || cfg.Installs["worker-g5"] == "" || cfg.Bootstrap != "" {
		t.Fatalf("without the bundle: %v %+v", err, cfg.Installs)
	}

	t.Setenv("FLEET_CONTROLPLANE_BUNDLE", bundle)
	if _, err := LoadInstaller(&Config{}, nil, nil, NewMetrics()); err == nil {
		t.Fatal("the bundle loaded without the bootstrap address")
	}
	t.Setenv("FLEET_BOOTSTRAP_ADDRESS", "10.3.0.10")
	cfg = Config{}
	in, err = LoadInstaller(&cfg, nil, nil, NewMetrics())
	if err != nil || !in.ControlPlanes || in.ControlPlaneTTL != 30*time.Minute || cfg.Installs["controlplane"] == "" || cfg.Bootstrap != "10.3.0.10" {
		t.Fatalf("with the bundle: %v %+v", err, cfg)
	}
	if r := in.Renderer.(*Talosctl); r.BundlePath != bundle {
		t.Fatalf("the renderer has no bundle: %q", r.BundlePath)
	}

	_ = os.WriteFile(bundle, []byte(fakeBundle("A")), 0o600)
	if _, err := LoadInstaller(&Config{}, nil, nil, NewMetrics()); err == nil {
		t.Fatal("a worker subset loaded as the bundle")
	}
}

func TestRenderRefusesADeviceWithoutTPMVersion(t *testing.T) {
	for _, c := range []struct {
		name string
		tpm  any
		want int
	}{
		{name: "empty tpm_version", tpm: nil, want: 409},
		{name: "recorded tpm_version", tpm: "2.0", want: 201},
		{name: "declared 1.2", tpm: "1.2", want: 201},
	} {
		t.Run(c.name, func(t *testing.T) {
			it := newInstallTest(t, "planned", map[string]any{"tpm_version": c.tpm})
			code, reason := it.render(goodRequest())
			if code != c.want {
				t.Fatalf("answered %d (%s), want %d", code, reason, c.want)
			}
			if (c.want == 201) != it.held(testCode) {
				t.Fatalf("config held: %v", it.held(testCode))
			}
			if c.want == 409 && it.rend.calls != 0 {
				t.Fatal("the renderer ran")
			}
		})
	}
}

// Two fetches at once get the config once: the second answers nothing while
// the first writes, and a fetch that breaks off gives it back.
func TestAConfigIsServedOnceToConcurrentFetches(t *testing.T) {
	it := newInstallTest(t, "planned", nil)
	if code, _ := it.render(goodRequest()); code != 201 {
		t.Fatal(code)
	}
	c := it.in.Configs
	if _, _, ok := c.Claim(testUUID, testCode, it.now); !ok {
		t.Fatal("the first fetch got nothing")
	}
	if _, _, ok := c.Claim(testUUID, testCode, it.now); ok {
		t.Fatal("a second fetch got the config while the first wrote it")
	}
	if w := it.fetch(http.MethodGet, testUUID, testCode, nil); w.Code != http.StatusNotFound {
		t.Fatalf("a concurrent GET answered %d", w.Code)
	}
	c.Unclaim(testUUID, testCode)
	if w := it.fetch(http.MethodGet, testUUID, testCode, nil); w.Code != http.StatusOK {
		t.Fatalf("the GET after the first broke off answered %d", w.Code)
	}
	if it.held(testCode) {
		t.Fatal("the config was not burned")
	}
}

// The answer goes out before NetBox hears of it: a NetBox that hangs never
// holds the node's fetch of a config that is already burned, and the next
// pass retries the release.
func TestTheConfigIsAnsweredBeforeItsRelease(t *testing.T) {
	it := newInstallTest(t, "planned", nil)
	if code, _ := it.render(goodRequest()); code != 201 {
		t.Fatal(code)
	}
	hang := make(chan struct{})
	// The fetch's read of the device answers; the release's writes hang.
	reads := it.nb.handler()
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			reads.ServeHTTP(w, r)
			return
		}
		<-hang
		http.Error(w, "gave up", http.StatusGatewayTimeout)
	}))
	defer slow.Close()
	good := *it.in.NetBox
	it.in.NetBox = &NetBox{URL: slow.URL, Token: "nbt_x.y", Client: slow.Client()}
	done := make(chan int, 1)
	go func() {
		w := httptest.NewRecorder()
		it.in.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/talos/config?uuid="+testUUID+"&code="+testCode, nil))
		done <- w.Code
	}()
	select {
	case code := <-done:
		if code != http.StatusOK {
			t.Fatalf("the fetch answered %d", code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the fetch waited on NetBox")
	}
	close(hang)
	it.in.Drain()
	it.in.NetBox = &good
	if len(it.in.Configs.Unreleased()) != 1 {
		t.Fatal("the release that NetBox did not take was dropped")
	}
	it.in.Tick(context.Background())
	if p := lastPatch(it.nb); p == nil || p["status"] != "active" || len(it.in.Configs.Unreleased()) != 0 {
		t.Fatalf("the pass did not retry the release: %v", p)
	}
}

// A restart keeps every config in the runtime directory with its TTL and
// burn state: an unread config is served after it, a served one waits for
// its release, and a spent code stays spent.
func TestConfigsSurviveARestart(t *testing.T) {
	dir := t.TempDir()
	it := newInstallTest(t, "planned", nil)
	it.in.Configs = &Configs{Dir: dir}
	if code, _ := it.render(goodRequest()); code != 201 {
		t.Fatal(code)
	}
	restart := func() *Configs {
		c := &Configs{Dir: dir}
		if err := c.Load(); err != nil {
			t.Fatal(err)
		}
		return c
	}
	it.in.Configs = restart()
	p, cfg, ok := it.in.Configs.Get(testUUID, testCode, it.now)
	if !ok || !strings.Contains(string(cfg), "riptide") || p.TTL != 2*time.Hour || !p.Rendered.Equal(testNow) {
		t.Fatalf("after a restart: %+v %q %v", p, cfg, ok)
	}
	if fi, err := os.Stat(filepath.Join(dir, testUUID+".json")); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("the record's mode: %v %v", fi, err)
	}
	// Served, then NetBox refuses the release, then a restart.
	it.nb.failPatch = true
	if w := it.fetch(http.MethodGet, testUUID, testCode, nil); w.Code != http.StatusOK {
		t.Fatal(w.Code)
	}
	it.in.Configs = restart()
	if u := it.in.Configs.Unreleased(); len(u) != 1 || u[0].Fetched.IsZero() {
		t.Fatalf("the served config's release was lost: %+v", u)
	}
	if _, _, ok := it.in.Configs.Get(testUUID, testCode, it.now); ok || !it.in.Configs.Spent(testUUID, testCode) {
		t.Fatal("a served code came back after a restart")
	}
	it.nb.failPatch = false
	it.in.Tick(context.Background())
	if _, err := os.Stat(filepath.Join(dir, testUUID+".json")); !os.IsNotExist(err) {
		t.Fatalf("the released record stayed: %v", err)
	}
	if !restart().Spent(testUUID, testCode) {
		t.Fatal("a restart forgot the spent code")
	}
	// A config past its TTL at a restart expires on the next pass.
	it.nb.set("status", map[string]any{"value": "planned"})
	req := goodRequest()
	req.Code = strings.Repeat("Y", 43)
	if code, why := it.render(req); code != 201 {
		t.Fatal(code, why)
	}
	it.now = testNow.Add(3 * time.Hour)
	it.in.Configs = restart()
	it.in.Tick(context.Background())
	if _, ok := it.in.Configs.Holds(testUUID); ok || it.in.Metrics.Expired.Load() != 1 {
		t.Fatal("a config past its TTL survived the restart")
	}
}
