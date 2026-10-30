package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha512"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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
	testUUID   = "4c4c4544-0042-3510-8051-b4c04f565432"
	testCode   = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde"
	testSecret = "s3cret"
	provWF     = "provision-riptide-1700000000"
)

type installTest struct {
	in   *Installer
	nb   *fakeNetBox
	kube *fakeKube
	rend *fakeRenderer
	dir  string
	log  string
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
	dir := t.TempDir()
	it := &installTest{nb: nb, kube: kube, dir: dir, log: filepath.Join(dir, "talos-config.log"), now: testNow}
	it.rend = &fakeRenderer{types: map[string]string{"worker-g5": "worker", "controlplane": "controlplane"}}
	it.in = &Installer{
		Site:     "folly",
		Secret:   []byte(testSecret),
		NetBox:   &NetBox{URL: nbs.URL, Token: "nbt_x.y", Client: nbs.Client()},
		Kube:     &Kube{Server: ks.URL, Namespace: "tinkerbell", Client: ks.Client()},
		Renderer: it.rend,
		Store:    &Store{Dir: filepath.Join(dir, "talos"), Burned: filepath.Join(dir, "burned.json")},
		Tail:     &Tail{Path: it.log, Offset: filepath.Join(dir, "talos-config.tail.json")},
		TTL:      2 * time.Hour,
		Metrics:  NewMetrics(),
		Now:      func() time.Time { return it.now },
	}
	return it
}

func sign(body []byte, secret string) string {
	mac := hmac.New(sha512.New, []byte(secret))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

func (it *installTest) post(t *testing.T, req RenderRequest, secret string) (int, string) {
	t.Helper()
	body, _ := json.Marshal(req)
	r := httptest.NewRequest(http.MethodPost, "/render", bytes.NewReader(body))
	r.Header.Set("X-Fleet-Signature", sign(body, secret))
	w := httptest.NewRecorder()
	it.in.ServeHTTP(w, r)
	var out struct {
		Reason string `json:"reason"`
	}
	json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out.Reason
}

func goodRequest() RenderRequest {
	return RenderRequest{Serial: "MXL0172Q6L", UUID: testUUID, Node: "riptide", Class: "worker-g5", Code: testCode}
}

func (it *installTest) cfgPath(code string) string {
	return filepath.Join(it.dir, "talos", testUUID, code+".yaml")
}

func (it *installTest) appendLog(t *testing.T, lines ...string) {
	t.Helper()
	f, err := os.OpenFile(it.log, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o640)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	for _, l := range lines {
		fmt.Fprintln(f, l)
	}
}

func TestRenderRejectsABadSignature(t *testing.T) {
	it := newInstallTest(t, "planned", nil)
	if code, _ := it.post(t, goodRequest(), "wrong"); code != http.StatusUnauthorized {
		t.Fatalf("a bad signature: %d", code)
	}
	if it.rend.calls != 0 || it.in.Metrics.RenderRejected.Load() != 1 {
		t.Fatal("a bad signature rendered, or went uncounted")
	}
	it.in.Secret = nil
	if code, _ := it.post(t, goodRequest(), testSecret); code != http.StatusServiceUnavailable {
		t.Fatalf("no secret configured: %d", code)
	}
}

func TestRenderRejectsAMalformedRequest(t *testing.T) {
	it := newInstallTest(t, "planned", nil)
	for _, mut := range []func(*RenderRequest){
		func(r *RenderRequest) { r.UUID = strings.ToUpper(testUUID) },
		func(r *RenderRequest) { r.Code = "../../etc/passwd" },
		func(r *RenderRequest) { r.Serial = "" },
	} {
		req := goodRequest()
		mut(&req)
		if code, _ := it.post(t, req, testSecret); code != http.StatusBadRequest {
			t.Errorf("%+v: %d", req, code)
		}
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
		{name: "a run from an older controller", status: "planned", kube: func(k *fakeKube) { delete(k.objects[wfBase+provWF], "spec") }, want: 409},
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
			code, reason := it.post(t, req, testSecret)
			if code != c.want {
				t.Fatalf("answered %d (%s), want %d", code, reason, c.want)
			}
			_, err := os.Stat(it.cfgPath(testCode))
			if (c.want == 201) != (err == nil) {
				t.Fatalf("answered %d, and the config exists: %v", code, err == nil)
			}
			if c.want != 201 && reason == "" {
				t.Fatal("a refusal without a reason")
			}
			if c.want == 503 && strings.Contains(reason, "worker-g9") {
				t.Fatalf("a 503 carries detail: %s", reason)
			}
			for _, echoed := range []string{"NOPE", "swell", "worker-g2", testCode} {
				if c.req != nil && strings.Contains(reason, echoed) {
					t.Fatalf("the reason echoes the request: %s", reason)
				}
			}
		})
	}
}

func TestRenderWritesTheConfigForNginx(t *testing.T) {
	it := newInstallTest(t, "planned", nil)
	if code, reason := it.post(t, goodRequest(), testSecret); code != 201 {
		t.Fatalf("%d %s", code, reason)
	}
	cfg, err := os.ReadFile(it.cfgPath(testCode))
	if err != nil || !strings.Contains(string(cfg), "riptide /dev/nvme0n1 2.0") {
		t.Fatalf("the config: %q %v", cfg, err)
	}
	for path, want := range map[string]os.FileMode{
		it.cfgPath(testCode): 0o640,
		strings.TrimSuffix(it.cfgPath(testCode), ".yaml") + ".json": 0o600,
		filepath.Dir(it.cfgPath(testCode)):                          0o750 | os.ModeDir,
		filepath.Join(it.dir, "talos"):                              0o750 | os.ModeDir,
	} {
		fi, err := os.Stat(path)
		if err != nil || fi.Mode() != want {
			t.Errorf("%s: mode %v, want %v (%v)", path, fi.Mode(), want, err)
		}
	}
	if it.in.Metrics.Rendered.Load() != 1 || it.in.Metrics.pending != 1 {
		t.Fatal("the render went uncounted")
	}

	// A new code for the same machine replaces the old one.
	req := goodRequest()
	req.Code = strings.Repeat("Z", 43)
	if code, _ := it.post(t, req, testSecret); code != 201 {
		t.Fatal(code)
	}
	if _, err := os.Stat(it.cfgPath(testCode)); !os.IsNotExist(err) {
		t.Fatal("the older code's config survived a new render")
	}
	if _, err := os.Stat(it.cfgPath(req.Code)); err != nil {
		t.Fatal(err)
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

// line is one talos-config log line in the fleet format.
func line(at, uuid, code string, status int, method, completion string, sent int64) string {
	return fmt.Sprintf("%s %s %s %d %s %s %d", at, uuid, code, status, method, completion, sent)
}

func (it *installTest) size(t *testing.T, code string) int64 {
	t.Helper()
	fi, err := os.Stat(it.cfgPath(code))
	if err != nil {
		t.Fatal(err)
	}
	return fi.Size()
}

func TestServedConfigIsBurnedAndTheDeviceGoesActive(t *testing.T) {
	it := newInstallTest(t, "planned", nil)
	if code, _ := it.post(t, goodRequest(), testSecret); code != 201 {
		t.Fatal(code)
	}
	ctx := context.Background()
	n := it.size(t, testCode)
	// A partial line waits for its end.
	it.appendLog(t, line("2023-11-14T22:20:00+00:00", testUUID, testCode, 200, "GET", "OK", n))
	f, _ := os.OpenFile(it.log, os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString("2023-11-14T22:21:00+00:00 " + testUUID)
	f.Close()

	served, err := it.in.Follow(ctx)
	if err != nil || !served {
		t.Fatalf("follow: %v %v", served, err)
	}
	if _, err := os.Stat(it.cfgPath(testCode)); !os.IsNotExist(err) {
		t.Fatal("a served config was not burned")
	}
	it.in.Sweep(ctx)
	p := lastPatch(it.nb)
	if p == nil || p["status"] != "active" || p["custom_fields"].(map[string]any)["attest_consumed_at"] != "2023-11-14T22:20:00Z" {
		t.Fatalf("the release patch: %v", p)
	}
	if recs, _ := it.in.Store.Records(); len(recs) != 0 {
		t.Fatalf("the record outlived the release: %+v", recs)
	}
	if journalCount(it.nb, "success") != 1 || it.in.Metrics.Released.Load() != 1 {
		t.Fatal("the release was not journaled once")
	}

	// A replay of the render call cannot bring the file back.
	it.nb.set("status", map[string]any{"value": "planned"})
	if code, reason := it.post(t, goodRequest(), testSecret); code != http.StatusConflict {
		t.Fatalf("a replayed render: %d %s", code, reason)
	}
	if _, err := os.Stat(it.cfgPath(testCode)); !os.IsNotExist(err) {
		t.Fatal("a replayed render recreated the file")
	}
	// The burned set survives a restart.
	it.in.Store = &Store{Dir: it.in.Store.Dir, Burned: it.in.Store.Burned}
	if code, _ := it.post(t, goodRequest(), testSecret); code != http.StatusConflict {
		t.Fatal("a restart forgot the burned code")
	}

	// A new Tail resumes from the saved offset: nothing is handled twice.
	before := len(it.nb.patches)
	it.in.Tail = &Tail{Path: it.in.Tail.Path, Offset: it.in.Tail.Offset}
	if _, err := it.in.Follow(ctx); err != nil {
		t.Fatal(err)
	}
	if len(it.nb.patches) != before {
		t.Fatal("a restart handled old lines again")
	}
}

func TestOnlyAWholeGetBurns(t *testing.T) {
	it := newInstallTest(t, "planned", nil)
	if code, _ := it.post(t, goodRequest(), testSecret); code != 201 {
		t.Fatal(code)
	}
	ctx := context.Background()
	n := it.size(t, testCode)
	at := "2023-11-14T22:20:00+00:00"
	it.appendLog(t,
		line(at, testUUID, testCode, 206, "GET", "OK", n),
		line(at, testUUID, testCode, 200, "HEAD", "OK", 0),
		line(at, testUUID, testCode, 200, "GET", "", n/2),
		line(at, testUUID, testCode, 200, "GET", "OK", n-1),
		line(at, testUUID, testCode, 405, "POST", "OK", 0),
		"not a fetch line",
	)
	if served, err := it.in.Follow(ctx); err != nil || served {
		t.Fatalf("a range, a HEAD, an aborted or short GET burned the file: %v %v", served, err)
	}
	if _, err := os.Stat(it.cfgPath(testCode)); err != nil {
		t.Fatal("the file is gone")
	}
	it.appendLog(t, line(at, testUUID, testCode, 200, "GET", "OK", n))
	if served, _ := it.in.Follow(ctx); !served {
		t.Fatal("a whole GET did not burn")
	}
}

func TestFailedReleaseIsKeptAndJournaledOnce(t *testing.T) {
	it := newInstallTest(t, "planned", nil)
	if code, _ := it.post(t, goodRequest(), testSecret); code != 201 {
		t.Fatal(code)
	}
	ctx := context.Background()
	it.appendLog(t, line("2023-11-14T22:20:00+00:00", testUUID, testCode, 200, "GET", "OK", it.size(t, testCode)))
	it.in.Follow(ctx)
	it.nb.failPatch = true
	for k := 0; k < 3; k++ {
		it.now = it.now.Add(3 * time.Hour)
		it.in.Sweep(ctx)
	}
	if recs, _ := it.in.Store.Records(); len(recs) != 1 || recs[0].Fetched.IsZero() {
		t.Fatalf("a release NetBox refused was dropped: %+v", recs)
	}
	if n := journalCount(it.nb, "danger"); n != 1 {
		t.Fatalf("%d failure journal entries, want 1", n)
	}
	if it.in.Metrics.unreleased != 1 || it.in.Metrics.pending != 0 {
		t.Fatalf("unreleased %d, pending %d", it.in.Metrics.unreleased, it.in.Metrics.pending)
	}
	it.nb.failPatch = false
	it.in.Sweep(ctx)
	if p := lastPatch(it.nb); p == nil || p["status"] != "active" {
		t.Fatalf("the retried release: %v", p)
	}
	if it.in.Metrics.unreleased != 0 {
		t.Fatal("the gauge kept a released config")
	}
}

// A disk error on the file's deletion leaves the served node to be
// released: the record and the burned hash are written first.
func TestServedNodeIsReleasedWhenItsFileWillNotGo(t *testing.T) {
	it := newInstallTest(t, "planned", nil)
	if code, _ := it.post(t, goodRequest(), testSecret); code != 201 {
		t.Fatal(code)
	}
	ctx := context.Background()
	// A non-empty directory in the config's place cannot be removed.
	cfg := it.cfgPath(testCode)
	if err := os.Remove(cfg); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(cfg, "stuck"), 0o750); err != nil {
		t.Fatal(err)
	}
	it.appendLog(t, line("2023-11-14T22:20:00+00:00", testUUID, testCode, 200, "GET", "OK", it.size(t, testCode)))
	if served, _ := it.in.Follow(ctx); !served {
		t.Fatal("a served config whose file would not go was not reported served")
	}
	if recs, _ := it.in.Store.Records(); len(recs) != 1 || recs[0].Fetched.IsZero() {
		t.Fatalf("the record does not say served: %+v", recs)
	}
	if !it.in.Store.Spent(testUUID, testCode) {
		t.Fatal("the code was not burned")
	}
	it.in.Sweep(ctx)
	if p := lastPatch(it.nb); p == nil || p["status"] != "active" {
		t.Fatalf("the release patch: %v", p)
	}
	it.nb.set("status", map[string]any{"value": "planned"})
	if code, _ := it.post(t, goodRequest(), testSecret); code != http.StatusConflict {
		t.Fatal("a served code rendered again")
	}
}

// A Drop that fails after NetBox took the release repeats neither the
// update nor the success journal on later sweeps.
func TestReleaseIsNotRepeatedWhenTheDropFails(t *testing.T) {
	it := newInstallTest(t, "planned", nil)
	if code, _ := it.post(t, goodRequest(), testSecret); code != 201 {
		t.Fatal(code)
	}
	ctx := context.Background()
	it.appendLog(t, line("2023-11-14T22:20:00+00:00", testUUID, testCode, 200, "GET", "OK", it.size(t, testCode)))
	if served, _ := it.in.Follow(ctx); !served {
		t.Fatal("not served")
	}
	// Drop burns the code first; a burned file it cannot write fails it.
	burned := it.in.Store.Burned
	it.in.Store.Burned = filepath.Join(it.dir, "absent", "burned.json")
	for k := 0; k < 3; k++ {
		it.in.Sweep(ctx)
	}
	if n := len(it.nb.patches); n != 1 {
		t.Fatalf("%d release patches, want 1", n)
	}
	if journalCount(it.nb, "success") != 1 || journalCount(it.nb, "danger") != 0 || it.in.Metrics.Released.Load() != 1 {
		t.Fatal("the release was repeated or journaled as refused")
	}
	recs, _ := it.in.Store.Records()
	if len(recs) != 1 || recs[0].Released.IsZero() {
		t.Fatalf("the record does not say released: %+v", recs)
	}
	if it.in.Metrics.unreleased != 0 {
		t.Fatal("the gauge counts a released config")
	}
	it.in.Store.Burned = burned
	it.in.Sweep(ctx)
	if recs, _ := it.in.Store.Records(); len(recs) != 0 {
		t.Fatalf("the record outlived a working Drop: %+v", recs)
	}
	if len(it.nb.patches) != 1 {
		t.Fatal("the final Drop updated NetBox")
	}
}

func TestNotFoundIsJournaledOnlyForAHeldMachineAndRateLimited(t *testing.T) {
	it := newInstallTest(t, "planned", nil)
	ctx := context.Background()
	other := "00000000-0000-0000-0000-000000000000"
	wrong := strings.Repeat("W", 43)
	at := "2023-11-14T22:20:00+00:00"
	// Nothing is held: a 404 reaches neither NetBox nor the journal.
	pages := it.nb.pages
	it.appendLog(t, line(at, testUUID, wrong, 404, "GET", "OK", 0), line(at, "-", "-", 404, "GET", "OK", 0))
	it.in.Follow(ctx)
	if it.nb.pages != pages || journalCount(it.nb, "warning") != 0 {
		t.Fatal("a 404 for a machine the store holds nothing for reached NetBox")
	}
	if code, _ := it.post(t, goodRequest(), testSecret); code != 201 {
		t.Fatal(code)
	}
	it.appendLog(t,
		line(at, testUUID, wrong, 404, "GET", "OK", 0),
		line(at, testUUID, strings.Repeat("V", 43), 404, "GET", "OK", 0),
		line(at, other, wrong, 404, "GET", "OK", 0))
	it.in.Follow(ctx)
	if n := journalCount(it.nb, "warning"); n != 1 {
		t.Fatalf("%d 404 journal entries, want 1", n)
	}
	it.now = it.now.Add(notFoundEvery)
	it.appendLog(t, line(at, testUUID, wrong, 404, "GET", "OK", 0))
	it.in.Follow(ctx)
	if n := journalCount(it.nb, "warning"); n != 2 {
		t.Fatalf("%d 404 journal entries after the window, want 2", n)
	}
	if len(it.in.journaled) != 1 {
		t.Fatalf("the rate limit kept %d entries", len(it.in.journaled))
	}
}

// TestParseFetchReadsNginxLines holds the parser to lines nginx 1.30 wrote
// in the fleet format: a whole GET, a GET the client aborted, whose
// $request_completion is empty, a refused HEAD, and a request without the
// arguments.
func TestParseFetchReadsNginxLines(t *testing.T) {
	const ts = "2026-10-29T13:31:24+00:00 "
	whole, ok := parseFetch(ts + testUUID + " " + testCode + " 200 GET OK 3000000")
	if !ok || !whole.Delivered() || whole.Sent != 3000000 || whole.UUID != testUUID || whole.Code != testCode {
		t.Fatalf("a whole GET: %+v %v", whole, ok)
	}
	aborted, ok := parseFetch(ts + testUUID + " " + testCode + " 200 GET  211041")
	if !ok || aborted.Delivered() || aborted.Sent != 211041 {
		t.Fatalf("an aborted GET: %+v %v", aborted, ok)
	}
	head, ok := parseFetch(ts + testUUID + " " + testCode + " 405 HEAD OK 0")
	if !ok || head.Delivered() || head.Status != 405 {
		t.Fatalf("a HEAD: %+v %v", head, ok)
	}
	if bare, ok := parseFetch(ts + "- - 404 GET OK 153"); !ok || bare.Status != 404 || uuidPattern.MatchString(bare.UUID) {
		t.Fatalf("no arguments: %+v %v", bare, ok)
	}
	for _, bad := range []string{"", "x", ts + testUUID + " " + testCode + " 200"} {
		if _, ok := parseFetch(bad); ok {
			t.Errorf("%q parsed", bad)
		}
	}
}

func TestTailFollowsARotation(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "log")
	tail := &Tail{Path: path, Offset: filepath.Join(dir, "offset")}
	if lines, err := tail.Read(); err != nil || lines != nil {
		t.Fatalf("a missing log: %v %v", lines, err)
	}
	os.WriteFile(path, []byte("a\nb\n"), 0o600)
	if lines, _ := tail.Read(); strings.Join(lines, ",") != "a,b" {
		t.Fatalf("first read: %v", lines)
	}
	// logrotate renames the file, nginx writes once more before it reopens.
	os.Rename(path, path+".1")
	old, _ := os.OpenFile(path+".1", os.O_APPEND|os.O_WRONLY, 0)
	old.WriteString("b2\n")
	os.WriteFile(path, []byte("c\n"), 0o600)
	if lines, _ := tail.Read(); strings.Join(lines, ",") != "b2,c" {
		t.Fatalf("after rotation: %v", lines)
	}
	old.WriteString("b3\n")
	old.Close()
	if lines, _ := tail.Read(); strings.Join(lines, ",") != "b3" {
		t.Fatalf("the old file's last lines: %v", lines)
	}
	os.WriteFile(path, []byte(""), 0o600)
	if lines, _ := tail.Read(); lines != nil {
		t.Fatalf("a truncated log: %v", lines)
	}
	os.WriteFile(path, []byte("d\n"), 0o600)
	if lines, _ := tail.Read(); strings.Join(lines, ",") != "d" {
		t.Fatalf("after truncation: %v", lines)
	}
}

func TestTailDrainsARotationWhileStopped(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "log")
	offset := filepath.Join(dir, "talos-config.tail.json")
	tail := &Tail{Path: path, Offset: offset}
	os.WriteFile(path, []byte("a\nb\n"), 0o600)
	if lines, _ := tail.Read(); strings.Join(lines, ",") != "a,b" {
		t.Fatalf("first read: %v", lines)
	}
	if err := tail.Save(); err != nil {
		t.Fatal(err)
	}
	// While the controller is stopped nginx writes more than one read's
	// chunk, then logrotate renames the file and nginx opens a new one.
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	row := strings.Repeat("x", 99)
	const rows = 50000
	for k := 0; k < rows; k++ {
		f.WriteString(row + "\n")
	}
	f.WriteString("c\n")
	f.Close()
	os.Rename(path, path+".1")
	os.WriteFile(path, []byte("d\n"), 0o600)

	tail = &Tail{Path: path, Offset: offset}
	lines, err := tail.Read()
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != rows+2 || lines[0] != row || lines[rows] != "c" || lines[rows+1] != "d" {
		t.Fatalf("%d lines after a rotation while stopped, want %d ending c,d", len(lines), rows+2)
	}
	if err := tail.Save(); err != nil {
		t.Fatal(err)
	}
	tail = &Tail{Path: path, Offset: offset}
	if lines, _ := tail.Read(); lines != nil {
		t.Fatalf("a restart after the drain read again: %d lines", len(lines))
	}
}

func TestUnreadConfigExpires(t *testing.T) {
	it := newInstallTest(t, "planned", nil)
	// A worker's config keeps the TTL beside the shorter control-plane one.
	it.in.ControlPlaneTTL = 30 * time.Minute
	if code, _ := it.post(t, goodRequest(), testSecret); code != 201 {
		t.Fatal(code)
	}
	ctx := context.Background()
	n := it.size(t, testCode)
	it.now = testNow.Add(time.Hour)
	it.in.Sweep(ctx)
	if _, err := os.Stat(it.cfgPath(testCode)); err != nil {
		t.Fatal("a config younger than the TTL expired")
	}
	if it.in.Metrics.pending != 1 {
		t.Fatal("the pending gauge lost it")
	}
	it.now = testNow.Add(2*time.Hour + time.Second)
	it.in.Sweep(ctx)
	if _, err := os.Stat(it.cfgPath(testCode)); !os.IsNotExist(err) {
		t.Fatal("an unread config outlived the TTL")
	}
	if journalCount(it.nb, "warning") != 1 || it.in.Metrics.Expired.Load() != 1 || it.in.Metrics.pending != 0 {
		t.Fatal("the expiry was not journaled and counted")
	}
	if p := lastPatch(it.nb); p != nil {
		t.Fatalf("an expiry changed the device: %v", p)
	}
	if entries, _ := os.ReadDir(filepath.Join(it.dir, "talos")); len(entries) != 0 {
		t.Fatalf("the machine's directory stayed: %v", entries)
	}
	// A served line for the expired code burns nothing and releases nothing,
	// and the expired code cannot be rendered again.
	it.appendLog(t, line("2023-11-15T01:00:00+00:00", testUUID, testCode, 200, "GET", "OK", n))
	if served, _ := it.in.Follow(ctx); served {
		t.Fatal("an expired code was released")
	}
	if code, _ := it.post(t, goodRequest(), testSecret); code != http.StatusConflict {
		t.Fatal("an expired code rendered again")
	}
}

func TestReleaseLeavesAStatusTheOwnerChanged(t *testing.T) {
	it := newInstallTest(t, "planned", nil)
	if code, _ := it.post(t, goodRequest(), testSecret); code != 201 {
		t.Fatal(code)
	}
	it.nb.set("status", map[string]any{"value": "decommissioning"})
	it.appendLog(t, line("2023-11-14T22:20:00+00:00", testUUID, testCode, 200, "GET", "OK", it.size(t, testCode)))
	ctx := context.Background()
	it.in.Follow(ctx)
	it.in.Sweep(ctx)
	p := lastPatch(it.nb)
	if p == nil || p["status"] != nil || p["custom_fields"] == nil {
		t.Fatalf("the release patch: %v", p)
	}
}

func TestWorkflowInstallsOnlyARenderedProvision(t *testing.T) {
	cfg := Config{Template: "provision", AttestURL: "http://a", NTPServer: "n",
		Installs: map[string]string{"worker-g5": "ghcr.io/jonpulsifer/talos-installer-folly:v1.14.4"}}
	hm := func(d Device, action string) map[string]any {
		return cfg.Workflow(d, action, testNow)["spec"].(map[string]any)["hardwareMap"].(map[string]any)
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
	// /render refuses a control plane with no address, so its run installs
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
		t.Errorf("a controller without a renderer installs: %v", m)
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
	if code, reason := it.post(t, req, testSecret); code != http.StatusConflict || !strings.Contains(reason, "the owner renders") {
		t.Fatalf("a control plane without the bundle: %d %s", code, reason)
	}
	it.in.ControlPlanes = true
	it.in.Bootstrap = "10.3.0.12"
	if code, _ := it.post(t, req, testSecret); code != http.StatusConflict {
		t.Fatalf("the bootstrap control plane: %d", code)
	}
	it.in.Bootstrap = "10.3.0.10"
	it.nb.devices[0]["primary_ip4"] = nil
	if code, _ := it.post(t, req, testSecret); code != http.StatusConflict {
		t.Fatalf("a control plane with no address: %d", code)
	}
	if it.rend.calls != 0 {
		t.Fatal("a refused control plane rendered")
	}
	it.nb.devices[0]["primary_ip4"] = map[string]any{"address": "10.3.0.12/26"}
	if code, reason := it.post(t, req, testSecret); code != http.StatusCreated {
		t.Fatalf("a joining control plane: %d %s", code, reason)
	}
	for path, want := range map[string]os.FileMode{
		it.cfgPath(testCode):               0o640,
		filepath.Dir(it.cfgPath(testCode)): 0o750 | os.ModeDir,
	} {
		if fi, err := os.Stat(path); err != nil || fi.Mode() != want {
			t.Errorf("%s: %v, want %v (%v)", path, fi.Mode(), want, err)
		}
	}
}

func TestControlPlaneConfigExpiresSooner(t *testing.T) {
	it, req := controlPlaneTest(t)
	it.in.ControlPlanes, it.in.Bootstrap, it.in.ControlPlaneTTL = true, "10.3.0.10", 30*time.Minute
	if code, _ := it.post(t, req, testSecret); code != http.StatusCreated {
		t.Fatal(code)
	}
	ctx := context.Background()
	it.now = testNow.Add(29 * time.Minute)
	it.in.Sweep(ctx)
	if _, err := os.Stat(it.cfgPath(testCode)); err != nil {
		t.Fatal("a control plane's config younger than its TTL expired")
	}
	it.now = testNow.Add(30*time.Minute + time.Second)
	it.in.Sweep(ctx)
	if _, err := os.Stat(it.cfgPath(testCode)); !os.IsNotExist(err) {
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
	t.Setenv("FLEET_STATE_DIR", dir)
	t.Setenv("FLEET_CLASS_INPUTS", classes)
	t.Setenv("FLEET_WORKER_SECRETS", workers)
	t.Setenv("FLEET_TALOSCTL", "/bin/false")
	t.Setenv("FLEET_INSTALLS", "true")
	t.Setenv("FLEET_CONTROLPLANE_BUNDLE", "")
	t.Setenv("FLEET_BOOTSTRAP_ADDRESS", "")

	cfg := Config{}
	in, err := loadInstaller(&cfg, nil, nil, NewMetrics())
	if err != nil || in.ControlPlanes || cfg.Installs["controlplane"] != "" || cfg.Installs["worker-g5"] == "" || cfg.Bootstrap != "" {
		t.Fatalf("without the bundle: %v %+v", err, cfg.Installs)
	}

	t.Setenv("FLEET_CONTROLPLANE_BUNDLE", bundle)
	if _, err := loadInstaller(&Config{}, nil, nil, NewMetrics()); err == nil {
		t.Fatal("the bundle loaded without the bootstrap address")
	}
	t.Setenv("FLEET_BOOTSTRAP_ADDRESS", "10.3.0.10")
	cfg = Config{}
	in, err = loadInstaller(&cfg, nil, nil, NewMetrics())
	if err != nil || !in.ControlPlanes || in.ControlPlaneTTL != 30*time.Minute || cfg.Installs["controlplane"] == "" || cfg.Bootstrap != "10.3.0.10" {
		t.Fatalf("with the bundle: %v %+v", err, cfg)
	}
	if r := in.Renderer.(*Talosctl); r.BundlePath != bundle {
		t.Fatalf("the renderer has no bundle: %q", r.BundlePath)
	}

	_ = os.WriteFile(bundle, []byte(fakeBundle("A")), 0o600)
	if _, err := loadInstaller(&Config{}, nil, nil, NewMetrics()); err == nil {
		t.Fatal("a worker subset loaded as the bundle")
	}
}

func TestRenderRefusesATPMModelWithoutTPMVersion(t *testing.T) {
	models := map[string]Model{"HP EliteDesk 800 G5 Desktop Mini": DefaultModels["HP EliteDesk 800 G5 Desktop Mini"]}
	for _, c := range []struct {
		name   string
		tpm    any
		models map[string]Model
		want   int
	}{
		{name: "empty tpm_version", tpm: nil, models: models, want: 409},
		{name: "recorded tpm_version", tpm: "2.0", models: models, want: 201},
		{name: "class without a TPM model", tpm: nil, models: map[string]Model{"x": {Class: "worker-g5"}}, want: 201},
	} {
		t.Run(c.name, func(t *testing.T) {
			it := newInstallTest(t, "planned", map[string]any{"tpm_version": c.tpm})
			it.in.Models = c.models
			code, reason := it.post(t, goodRequest(), testSecret)
			if code != c.want {
				t.Fatalf("answered %d (%s), want %d", code, reason, c.want)
			}
			if _, err := os.Stat(it.cfgPath(testCode)); (c.want == 201) != (err == nil) {
				t.Fatalf("config exists: %v", err == nil)
			}
			if c.want == 409 && it.rend.calls != 0 {
				t.Fatal("the renderer ran")
			}
		})
	}
}
