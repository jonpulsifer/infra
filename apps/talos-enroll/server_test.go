package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

const testUUID = "4c4c4544-0042-3510-8051-b4c04f4e3732"

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) Add(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

type fakeRender struct {
	mu    sync.Mutex
	fail  error
	calls int
	large bool
}

func (f *fakeRender) Classes() []string { return []string{"controlplane", "worker-g5"} }
func (f *fakeRender) MachineType(class string) string {
	switch class {
	case "controlplane":
		return "controlplane"
	case "worker-g5":
		return "worker"
	}
	return ""
}
func (f *fakeRender) Render(_ context.Context, n Node) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if f.fail != nil {
		return nil, f.fail
	}
	if n.Class != "controlplane" && n.Class != "worker-g5" {
		return nil, ErrNoClass
	}
	body := "version: v1alpha1\n# " + n.Name + "\n"
	if f.large {
		body += "# " + strings.Repeat("x", 9000) + "\n"
	}
	return []byte(body), nil
}

// fakeDirectory is NetBox, or the inventory, in memory.
type fakeDirectory struct {
	mu          sync.Mutex
	nodes       map[string]Node
	fail        error
	spendFail   error
	releaseFail error
	spends      []release
	releases    []release
}

type release struct {
	node string
	at   time.Time
}

func newFakeDirectory() *fakeDirectory {
	return &fakeDirectory{nodes: map[string]Node{
		"riptide":  {Name: "riptide", Serial: testSerial, MAC: "38:22:e2:2d:96:44", Class: "worker-g5", Disk: "/dev/nvme0n1", TPM: "2.0", Status: "active", Source: "inventory"},
		"optiplex": {Name: "optiplex", Serial: "66BT7M2", MAC: "14:b3:1f:2b:57:85", Class: "controlplane", Disk: "/dev/sda", TPM: "2.0", Status: "active", Source: "inventory"},
	}}
}

func (f *fakeDirectory) set(name string, mutate func(*Node)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := f.nodes[name]
	mutate(&n)
	f.nodes[name] = n
}

func (f *fakeDirectory) BySerial(_ context.Context, serial string) (Node, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail != nil {
		return Node{}, f.fail
	}
	for _, n := range f.nodes {
		if strings.EqualFold(n.Serial, serial) {
			return n, nil
		}
	}
	return Node{}, ErrUnknownNode
}

func (f *fakeDirectory) ByName(_ context.Context, name string) (Node, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail != nil {
		return Node{}, f.fail
	}
	n, ok := f.nodes[name]
	if !ok {
		return Node{}, ErrUnknownNode
	}
	if retired(n.Status) {
		return Node{}, ErrRetired
	}
	return n, nil
}

func (f *fakeDirectory) Names(context.Context) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail != nil {
		return nil, f.fail
	}
	return []string{"optiplex", "riptide"}, nil
}

// Spend and Released refuse a context that is already done, as a real client
// would, so that a test can prove the release outlives the request.
func (f *fakeDirectory) Spend(ctx context.Context, n Node, at time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if f.spendFail != nil {
		return f.spendFail
	}
	f.spends = append(f.spends, release{n.Name, at})
	node := f.nodes[n.Name]
	node.ConsumedAt = at
	f.nodes[n.Name] = node
	return nil
}

func (f *fakeDirectory) Released(ctx context.Context, n Node, at time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if f.releaseFail != nil {
		return f.releaseFail
	}
	f.releases = append(f.releases, release{n.Name, at})
	node := f.nodes[n.Name]
	if node.Status == "planned" || node.Status == "staged" {
		node.Status = "active"
	}
	node.ConsumedAt = at
	f.nodes[n.Name] = node
	return nil
}

func (f *fakeDirectory) released() []release {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]release{}, f.releases...)
}

func (f *fakeDirectory) spent() []release {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]release{}, f.spends...)
}

type fakeNotifier struct {
	mu   sync.Mutex
	msgs map[string][]string
}

func (f *fakeNotifier) Notify(_ context.Context, key, content string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.msgs[key] = append(f.msgs[key], content)
	return nil
}

func (f *fakeNotifier) last(t *testing.T, key string, n int) string {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		f.mu.Lock()
		got := f.msgs[key]
		f.mu.Unlock()
		if len(got) >= n {
			return got[n-1]
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("notification %d for %s never arrived", n, key)
	return ""
}

type harness struct {
	t      *testing.T
	clock  *clock
	render *fakeRender
	dir    *fakeDirectory
	notes  *fakeNotifier
	public http.Handler
	admin  http.Handler
	srv    *Server
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	c := &clock{t: time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)}
	notes := &fakeNotifier{msgs: map[string][]string{}}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	out := NewOutbox(notes, log)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go out.Run(ctx)
	r := &fakeRender{}
	d := newFakeDirectory()
	s := &Server{
		Store:     NewStore(c.Now),
		Render:    r,
		Dir:       d,
		Out:       out,
		Log:       log,
		Site:      "folly",
		ClientID:  "talos-enroll",
		Approvers: map[string]bool{"owner@example.com": true},
		AdminURL:  "https://talos-enroll.example.ts.net",
		Now:       c.Now,
	}
	return &harness{t: t, clock: c, render: r, dir: d, notes: notes, public: s.Public(), admin: s.Admin(), srv: s}
}

func (h *harness) do(handler http.Handler, req *http.Request) (int, map[string]any, string) {
	h.t.Helper()
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	body := rec.Body.String()
	var m map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &m)
	return rec.Code, m, body
}

func form(path string, v url.Values) *http.Request {
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(v.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	return req
}

func deviceForm(uuid string) url.Values {
	return url.Values{
		"client_id": {"talos-enroll"},
		"uuid":      {uuid},
		"mac":       {"38:22:e2:2d:96:44"},
		"serial":    {"CZC1234"},
		"hostname":  {"talos-abc-def"},
	}
}

func (h *harness) startDevice(uuid string) (deviceCode, userCode string) {
	h.t.Helper()
	code, m, body := h.do(h.public, form("/device/code", deviceForm(uuid)))
	if code != http.StatusOK {
		h.t.Fatalf("device code: %d %s", code, body)
	}
	if m["expires_in"].(float64) != 900 || m["interval"].(float64) != 5 {
		h.t.Fatalf("expires_in and interval must be 900 and 5: %v", m)
	}
	if m["verification_uri"] == "" {
		h.t.Fatalf("verification_uri is required: %v", m)
	}
	return m["device_code"].(string), m["user_code"].(string)
}

// poll sends Talos's pair: one with Basic auth and one without, and requires
// the same answer to both.
func (h *harness) poll(deviceCode, uuid string) (int, map[string]any) {
	h.t.Helper()
	v := url.Values{
		"client_id":   {"talos-enroll"},
		"grant_type":  {grantDeviceCode},
		"device_code": {deviceCode},
		"uuid":        {uuid},
		"mac":         {"38:22:e2:2d:96:44"},
	}
	a := form("/token", v)
	a.SetBasicAuth("talos-enroll", "")
	codeA, mA, _ := h.do(h.public, a)
	codeB, mB, _ := h.do(h.public, form("/token", v))
	if codeA != codeB || mA["error"] != mB["error"] || mA["access_token"] != mB["access_token"] {
		h.t.Fatalf("the two polls of a pair differ: %d %v / %d %v", codeA, mA, codeB, mB)
	}
	return codeA, mA
}

func (h *harness) adminReq(method, path string, v url.Values, login string) *http.Request {
	var req *http.Request
	if v != nil {
		req = form(path, v)
		req.Method = method
	} else {
		req = httptest.NewRequest(method, path, nil)
		req.Header.Set("Accept", "application/json")
	}
	if login != "" {
		req.Header.Set("Tailscale-User-Login", login)
	}
	return req
}

func (h *harness) approve(userCode, node string) (int, map[string]any) {
	h.t.Helper()
	code, m, _ := h.do(h.admin, h.adminReq(http.MethodPost, "/approve", url.Values{"code": {userCode}, "node": {node}}, "Owner@example.com"))
	return code, m
}

func (h *harness) deny(uuid string) (int, map[string]any) {
	h.t.Helper()
	code, m, _ := h.do(h.admin, h.adminReq(http.MethodPost, "/deny", url.Values{"uuid": {uuid}}, "owner@example.com"))
	return code, m
}

func (h *harness) metric(name string) string {
	h.t.Helper()
	_, _, body := h.do(h.public, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	for _, line := range strings.Split(body, "\n") {
		if v, ok := strings.CutPrefix(line, name+" "); ok {
			return v
		}
	}
	h.t.Fatalf("/metrics has no %s:\n%s", name, body)
	return ""
}

func getConfig(token, rawQuery string) *http.Request {
	req := httptest.NewRequest(http.MethodGet, "/config?"+rawQuery, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	return req
}

func configQuery(uuid string) string {
	return url.Values{"uuid": {uuid}, "mac": {"38:22:e2:2d:96:44"}, "serial": {"CZC1234"}}.Encode()
}

func TestApprovedFlowServesConfigOnce(t *testing.T) {
	h := newHarness(t)
	dc, uc := h.startDevice(testUUID)

	msg := h.notes.last(t, testUUID, 1)
	for _, want := range []string{testUUID, "38:22:e2:2d:96:44", "talos-abc-def", "mise run enroll:approve <console code> riptide", "mise run enroll:deny " + testUUID} {
		if !strings.Contains(msg, want) {
			t.Fatalf("the prompt lacks %q:\n%s", want, msg)
		}
	}
	if strings.Contains(msg, uc) {
		t.Fatalf("the prompt must not carry the user code, which only the console shows:\n%s", msg)
	}

	if code, m := h.poll(dc, testUUID); code != 400 || m["error"] != "authorization_pending" {
		t.Fatalf("before approval: %d %v", code, m)
	}

	if code, m := h.approve(uc, "riptide"); code != 200 || m["node"] != "riptide" || m["mac_mismatch"] != false {
		t.Fatalf("approve: %d %v", code, m)
	}
	code, m := h.poll(dc, testUUID)
	if code != 200 || m["token_type"] != "Bearer" || m["access_token"] == "" || m["expires_in"].(float64) < 1800-1 {
		t.Fatalf("after approval: %d %v", code, m)
	}
	token := m["access_token"].(string)

	if code, _, _ := h.do(h.public, getConfig("", configQuery(testUUID))); code != 401 {
		t.Fatalf("no token: %d", code)
	}
	if code, _, _ := h.do(h.public, getConfig(token, configQuery("4c4c4544-ffff"))); code != 403 {
		t.Fatalf("another uuid: %d", code)
	}
	literal := "uuid=${uuid}&mac=${mac}"
	if code, _, _ := h.do(h.public, getConfig(token, literal)); code != 400 {
		t.Fatalf("literal placeholder: %d", code)
	}
	encoded := "uuid=%24%7Buuid%7D"
	if code, _, _ := h.do(h.public, getConfig(token, encoded)); code != 400 {
		t.Fatalf("encoded placeholder: %d", code)
	}

	code, _, body := h.do(h.public, getConfig(token, configQuery(strings.ToUpper(testUUID))))
	if code != 200 || body != "version: v1alpha1\n# riptide\n" {
		t.Fatalf("config: %d %q", code, body)
	}
	if code, _, _ := h.do(h.public, getConfig(token, configQuery(testUUID))); code != 401 {
		t.Fatalf("a second request with the same token must be refused, got %d", code)
	}
	if code, m := h.poll(dc, testUUID); code != 400 || m["error"] != "expired_token" {
		t.Fatalf("a poll after the config was served: %d %v", code, m)
	}
	if !strings.Contains(h.notes.last(t, testUUID, 3), "fetched its config") {
		t.Fatal("the served config was not announced")
	}
}

func TestDenyRefusesTheMachineAfterwards(t *testing.T) {
	h := newHarness(t)
	dc, uc := h.startDevice(testUUID)

	if code, m := h.deny(uc); code != 404 {
		t.Fatalf("deny takes the uuid, not the user code: %d %v", code, m)
	}
	if code, m := h.deny(strings.ToUpper(testUUID)); code != 200 || m["phase"] != "denied" {
		t.Fatalf("deny: %d %v", code, m)
	}
	if code, m := h.poll(dc, testUUID); code != 400 || m["error"] != "access_denied" {
		t.Fatalf("poll after deny: %d %v", code, m)
	}
	code, m, _ := h.do(h.public, form("/device/code", deviceForm(strings.ToUpper(testUUID))))
	if code != 403 || m["error"] != "access_denied" {
		t.Fatalf("a new device request from a denied uuid: %d %v", code, m)
	}
	if code, _ := h.approve(uc, "riptide"); code != 409 {
		t.Fatalf("approving a denied code: %d", code)
	}
}

func TestNewDeviceCodeSupersedesTheOldOne(t *testing.T) {
	h := newHarness(t)
	dc1, uc1 := h.startDevice(testUUID)
	h.notes.last(t, testUUID, 1)
	h.clock.Add(time.Minute)
	dc2, uc2 := h.startDevice(testUUID)

	if code, m := h.poll(dc1, testUUID); code != 400 || m["error"] != "expired_token" {
		t.Fatalf("the old code: %d %v", code, m)
	}
	if code, m := h.poll(dc2, testUUID); code != 400 || m["error"] != "authorization_pending" {
		t.Fatalf("the new code: %d %v", code, m)
	}
	if code, _ := h.approve(uc1, "riptide"); code != 409 && code != 404 {
		t.Fatalf("approving the old code: %d", code)
	}
	_, m, _ := h.do(h.admin, h.adminReq(http.MethodGet, "/pending", nil, "owner@example.com"))
	list := m["enrollments"].([]any)
	if len(list) != 1 || list[0].(map[string]any)["device"].(map[string]any)["uuid"] != testUUID {
		t.Fatalf("one prompt per uuid: %v", list)
	}
	if _, ok := list[0].(map[string]any)["user_code"]; ok {
		t.Fatalf("the pending list must not carry the user code: %v", list[0])
	}
	if list[0].(map[string]any)["suggested_node"] != "riptide" {
		t.Fatalf("the MAC hint is missing: %v", list[0])
	}
	if msg := h.notes.last(t, testUUID, 2); strings.Contains(msg, uc2) || !strings.Contains(msg, "waiting for approval") {
		t.Fatalf("the prompt for the uuid was not replaced, or it carries the code:\n%s", msg)
	}
	if code, m := h.approve(uc2, "riptide"); code != 200 {
		t.Fatalf("approving the code on the console: %d %v", code, m)
	}
}

// Talos asks for a new code 30 s after each one expires. The wait must not
// reset in that gap, or an alert keyed on it never fires.
func TestWaitSpansDeviceCodes(t *testing.T) {
	h := newHarness(t)
	_, _ = h.startDevice(testUUID)
	if got := h.metric("talos_enroll_waiting_machines"); got != "1" {
		t.Fatalf("waiting machines at the first code: %s", got)
	}
	for range 4 {
		h.clock.Add(15 * time.Minute)
		if got := h.metric("talos_enroll_pending"); got != "0" {
			t.Fatalf("a pending code past its expiry: %s", got)
		}
		h.clock.Add(30 * time.Second)
		if got := h.metric("talos_enroll_waiting_machines"); got != "1" {
			t.Fatalf("the machine stopped counting as waiting between codes: %s", got)
		}
		h.startDevice(testUUID)
	}
	if got := h.metric("talos_enroll_longest_wait_seconds"); got != "3720" {
		t.Fatalf("the wait across four codes: %s", got)
	}

	_, uc := h.startDevice(testUUID)
	if code, m := h.approve(uc, "riptide"); code != 200 {
		t.Fatalf("approve: %d %v", code, m)
	}
	if got := h.metric("talos_enroll_waiting_machines"); got != "0" {
		t.Fatalf("an approved machine still waits: %s", got)
	}
	if got := h.metric("talos_enroll_longest_wait_seconds"); got != "0" {
		t.Fatalf("the wait after approval: %s", got)
	}
}

func TestQuietMachineStopsWaiting(t *testing.T) {
	h := newHarness(t)
	h.startDevice(testUUID)
	h.clock.Add(20 * time.Minute)
	if got := h.metric("talos_enroll_waiting_machines"); got != "1" {
		t.Fatalf("within the grace after expiry: %s", got)
	}
	if code, m := h.deny(testUUID); code != 200 {
		t.Fatalf("deny between codes: %d %v", code, m)
	}
	if code, _, _ := h.do(h.public, form("/device/code", deviceForm(testUUID))); code != 403 {
		t.Fatalf("a denied uuid asked again: %d", code)
	}

	h.startDevice("another-machine")
	h.clock.Add(21 * time.Minute)
	if got := h.metric("talos_enroll_waiting_machines"); got != "0" {
		t.Fatalf("a machine quiet past its code and the grace still waits: %s", got)
	}
	if code, _ := h.deny("another-machine"); code != 404 {
		t.Fatalf("deny of a forgotten machine: %d", code)
	}
}

func TestDeviceCodeExpires(t *testing.T) {
	h := newHarness(t)
	dc, uc := h.startDevice(testUUID)
	h.clock.Add(900 * time.Second)
	if code, m := h.poll(dc, testUUID); code != 400 || m["error"] != "expired_token" {
		t.Fatalf("an expired code: %d %v", code, m)
	}
	if code, _ := h.approve(uc, "riptide"); code != 409 {
		t.Fatalf("approving an expired code: %d", code)
	}
}

func TestTokenExpires(t *testing.T) {
	h := newHarness(t)
	dc, uc := h.startDevice(testUUID)
	h.approve(uc, "optiplex")
	_, m := h.poll(dc, testUUID)
	token := m["access_token"].(string)
	h.clock.Add(29 * time.Minute)
	if code, m := h.poll(dc, testUUID); code != 200 || m["access_token"] != token {
		t.Fatalf("a repeat poll returns the same token: %d %v", code, m)
	}
	h.clock.Add(time.Minute)
	if code, _, _ := h.do(h.public, getConfig(token, configQuery(testUUID))); code != 401 {
		t.Fatalf("an expired token: %d", code)
	}
}

func TestRenderFailureKeepsTheEnrollmentPending(t *testing.T) {
	h := newHarness(t)
	dc, uc := h.startDevice(testUUID)
	h.render.fail = errors.New("boom")
	if code, _ := h.approve(uc, "riptide"); code != 500 {
		t.Fatalf("approve with a failing render: %d", code)
	}
	if code, m := h.poll(dc, testUUID); code != 400 || m["error"] != "authorization_pending" {
		t.Fatalf("no token before a config renders: %d %v", code, m)
	}
	h.render.fail = nil
	if code, _ := h.approve(uc, "shale"); code != 400 {
		t.Fatalf("a node with no machine inputs: %d", code)
	}
	if code, _ := h.approve(uc, ""); code != 400 {
		t.Fatalf("no node: %d", code)
	}
	if code, m := h.approve(uc, "riptide"); code != 200 {
		t.Fatalf("approve: %d %v", code, m)
	}
}

func TestMACMismatchIsReported(t *testing.T) {
	h := newHarness(t)
	h.dir.set("riptide", func(n *Node) { n.MAC = "aa:aa:aa:aa:aa:aa" })
	_, uc := h.startDevice(testUUID)
	if msg := h.notes.last(t, testUUID, 1); !strings.Contains(msg, "but its MAC is not") || strings.Contains(msg, "<console code> riptide") {
		t.Fatalf("a serial match with another MAC must not suggest the node:\n%s", msg)
	}
	if code, m := h.approve(uc, "riptide"); code != 200 || m["mac_mismatch"] != true {
		t.Fatalf("approve: %d %v", code, m)
	}
	if rel := h.dir.released(); len(rel) != 0 {
		t.Fatalf("nothing is released before the config is fetched: %v", rel)
	}
}

func TestDirectoryOutageKeepsTheClickPath(t *testing.T) {
	h := newHarness(t)
	h.dir.fail = errors.New("netbox down")
	_, uc := h.startDevice(testUUID)
	if msg := h.notes.last(t, testUUID, 1); !strings.Contains(msg, "matches no device") {
		t.Fatalf("an outage must read as an unknown machine, not crash:\n%s", msg)
	}
	if code, _ := h.approve(uc, "riptide"); code != 502 {
		t.Fatalf("approve during an outage: %d", code)
	}
	h.dir.fail = nil
	if code, _ := h.approve(uc, "riptide"); code != 200 {
		t.Fatalf("approve after the outage: %d", code)
	}
}

func TestServedConfigIsReleasedToTheDirectory(t *testing.T) {
	h := newHarness(t)
	dc, uc := h.startDevice(testUUID)
	h.approve(uc, "riptide")
	_, m := h.poll(dc, testUUID)
	if code, _, _ := h.do(h.public, getConfig(m["access_token"].(string), configQuery(testUUID))); code != 200 {
		t.Fatalf("config: %d", code)
	}
	rel := h.dir.released()
	if len(rel) != 1 || rel[0].node != "riptide" || !rel[0].at.Equal(h.clock.Now()) {
		t.Fatalf("a click release names the node and the release time: %v", rel)
	}
	if n, _ := h.dir.ByName(context.Background(), "riptide"); n.Status != "active" || !n.ConsumedAt.Equal(h.clock.Now()) {
		t.Fatalf("after the release the device is active and any earlier pass is spent: %+v", n)
	}
}

func TestReleaseFailureStillServesTheConfig(t *testing.T) {
	h := newHarness(t)
	dc, uc := h.startDevice(testUUID)
	h.approve(uc, "riptide")
	_, m := h.poll(dc, testUUID)
	h.dir.releaseFail = errors.New("netbox 503")
	code, _, body := h.do(h.public, getConfig(m["access_token"].(string), configQuery(testUUID)))
	if code != 200 || !strings.HasPrefix(body, "version: v1alpha1") {
		t.Fatalf("the config must be served whatever NetBox says: %d", code)
	}
	if code, _, _ := h.do(h.public, getConfig(m["access_token"].(string), configQuery(testUUID))); code != 401 {
		t.Fatal("the token must be spent even when the release was not recorded")
	}
	if !strings.Contains(h.notes.last(t, testUUID, 3), "fetched its config") {
		t.Fatal("the served config was not announced")
	}
}

// The proxy closes the upstream once the body is out, and Go cancels the
// request's context; the release must still reach the directory.
func TestReleaseOutlivesTheRequestContext(t *testing.T) {
	h := newHarness(t)
	dc, uc := h.startDevice(testUUID)
	h.approve(uc, "riptide")
	_, m := h.poll(dc, testUUID)
	req := getConfig(m["access_token"].(string), configQuery(testUUID))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	code, _, _ := h.do(h.public, req.WithContext(ctx))
	if code != 200 {
		t.Fatalf("config: %d", code)
	}
	if rel := h.dir.released(); len(rel) != 1 {
		t.Fatalf("the release did not survive a cancelled request context: %v", rel)
	}
}

// A real listener, a 9 KB config, and a client that closes the connection
// as soon as the body is in.
func TestReleaseAfterAClientThatClosesOnTheBody(t *testing.T) {
	h := newHarness(t)
	h.render.large = true
	dc, uc := h.startDevice(testUUID)
	h.approve(uc, "riptide")
	_, m := h.poll(dc, testUUID)

	srv := httptest.NewServer(h.public)
	defer srv.Close()
	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/config?"+configQuery(testUUID), nil)
	req.Header.Set("Authorization", "Bearer "+m["access_token"].(string))
	req.Close = true
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	srv.Client().CloseIdleConnections()
	if resp.StatusCode != 200 || len(body) < 9000 {
		t.Fatalf("config: %d, %d bytes", resp.StatusCode, len(body))
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if rel := h.dir.released(); len(rel) == 1 && rel[0].node == "riptide" {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("the release never reached the directory")
}

func TestRetiredNodeIsNotApprovable(t *testing.T) {
	h := newHarness(t)
	h.dir.set("optiplex", func(n *Node) { n.Status = "offline" })
	_, uc := h.startDevice(testUUID)
	if code, m := h.approve(uc, "optiplex"); code != 409 || !strings.Contains(m["error"].(string), "retired") {
		t.Fatalf("approving a retired device: %d %v", code, m)
	}
}

func TestDeviceRequestValidation(t *testing.T) {
	h := newHarness(t)
	cases := map[string]struct {
		mutate func(url.Values)
		status int
		err    string
	}{
		"wrong client":  {func(v url.Values) { v.Set("client_id", "other") }, 401, "invalid_client"},
		"no uuid":       {func(v url.Values) { v.Del("uuid") }, 400, "invalid_request"},
		"placeholder":   {func(v url.Values) { v.Set("mac", "${mac}") }, 400, "invalid_request"},
		"control chars": {func(v url.Values) { v.Set("hostname", "a\x00b") }, 400, "invalid_request"},
		"empty mac":     {func(v url.Values) { v.Set("mac", "") }, 200, ""},
	}
	for name, tc := range cases {
		v := deviceForm(testUUID + "-" + strings.ReplaceAll(name, " ", ""))
		tc.mutate(v)
		code, m, _ := h.do(h.public, form("/device/code", v))
		if code != tc.status || (tc.err != "" && m["error"] != tc.err) {
			t.Errorf("%s: %d %v", name, code, m)
		}
	}
}

func TestTokenRequestValidation(t *testing.T) {
	h := newHarness(t)
	dc, _ := h.startDevice(testUUID)
	v := url.Values{"client_id": {"talos-enroll"}, "grant_type": {"password"}, "device_code": {dc}}
	if code, m, _ := h.do(h.public, form("/token", v)); code != 400 || m["error"] != "unsupported_grant_type" {
		t.Fatalf("grant type: %d %v", code, m)
	}
	if code, m := h.poll("nope", testUUID); code != 400 || m["error"] != "invalid_grant" {
		t.Fatalf("unknown device code: %d %v", code, m)
	}
	if code, m := h.poll(dc, "4c4c4544-ffff"); code != 400 || m["error"] != "invalid_grant" {
		t.Fatalf("a device code polled by another uuid: %d %v", code, m)
	}
}

func TestAdminRequiresAnApprover(t *testing.T) {
	h := newHarness(t)
	_, uc := h.startDevice(testUUID)
	for _, login := range []string{"", "someone@example.com"} {
		if code, _, _ := h.do(h.admin, h.adminReq(http.MethodPost, "/approve", url.Values{"code": {uc}, "node": {"riptide"}}, login)); code != 403 {
			t.Fatalf("login %q: %d", login, code)
		}
		if code, _, _ := h.do(h.admin, h.adminReq(http.MethodPost, "/deny", url.Values{"uuid": {testUUID}}, login)); code != 403 {
			t.Fatalf("deny as login %q: %d", login, code)
		}
	}
	req := h.adminReq(http.MethodPost, "/approve", url.Values{"code": {uc}, "node": {"riptide"}}, "owner@example.com")
	req.Header.Set("Origin", "https://evil.example")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	if code, _, _ := h.do(h.admin, req); code != 403 {
		t.Fatalf("a cross-site form: %d", code)
	}
	req.Header.Del("Sec-Fetch-Site")
	if code, _, _ := h.do(h.admin, req); code != 403 {
		t.Fatalf("a foreign Origin with no fetch metadata: %d", code)
	}
	if h.render.calls != 0 {
		t.Fatal("a refused approval rendered a config")
	}
	page := h.adminReq(http.MethodGet, "/?code="+uc, nil, "owner@example.com")
	if code, _, body := h.do(h.admin, page); code != 200 || !strings.Contains(body, `value="`+uc+`"`) || !strings.Contains(body, "card focus") {
		t.Fatalf("the page with the console's code: %d", code)
	}
	if code, _, body := h.do(h.admin, h.adminReq(http.MethodGet, "/", nil, "owner@example.com")); code != 200 || strings.Contains(body, uc) || !strings.Contains(body, testUUID) {
		t.Fatalf("the page without a code must list the machine and hide its code: %d\n%s", code, body)
	}
}

func TestOneLiveEnrollmentCap(t *testing.T) {
	h := newHarness(t)
	for i := range 32 {
		h.startDevice(base64.RawURLEncoding.EncodeToString([]byte{byte(i), 1, 2}))
	}
	code, m, _ := h.do(h.public, form("/device/code", deviceForm("one-too-many")))
	if code != 503 || m["error"] != "temporarily_unavailable" {
		t.Fatalf("over the cap: %d %v", code, m)
	}
}
