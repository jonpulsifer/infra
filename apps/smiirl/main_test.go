package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

var atlantic = mustLoc("Canada/Atlantic")

func mustLoc(name string) *time.Location {
	loc, err := time.LoadLocation(name)
	if err != nil {
		panic(err)
	}
	return loc
}

func utc(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return t
}

func newTest(t *testing.T) (*server, *httptest.Server) {
	t.Helper()
	s, err := newServer(t.TempDir(), atlantic)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s.handler())
	t.Cleanup(ts.Close)
	return s, ts
}

func do(t *testing.T, ts *httptest.Server, method, path, body string, hdr http.Header) (*http.Response, map[string]any) {
	t.Helper()
	req, err := http.NewRequest(method, ts.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range hdr {
		req.Header[k] = v
	}
	if h := hdr.Get("Host"); h != "" {
		req.Host = h
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp, out
}

func TestBootstrapUsesHostHeader(t *testing.T) {
	_, ts := newTest(t)
	resp, out := do(t, ts, "GET", "/v1.0/aabbccddeeff/0123abcd", "", http.Header{"Host": {"api.smiirl.com"}})
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("status %d content-type %q", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	if out["url"] != "http://api.smiirl.com/aabbccddeeff/number" || out["v"] != "smiirl_2.0.7-1" || out["interval"] != float64(20) {
		t.Fatalf("bootstrap = %v", out)
	}
	if resp, _ := do(t, ts, "GET", "/v1.0/AABBCCDDEEFF/0123abcd", "", nil); resp.StatusCode != 404 {
		t.Fatalf("uppercase mac: status %d", resp.StatusCode)
	}
	if resp, _ := do(t, ts, "GET", "/nope", "", nil); resp.StatusCode != 404 {
		t.Fatalf("unknown path: status %d", resp.StatusCode)
	}
}

func TestRegisterAndRecover(t *testing.T) {
	_, ts := newTest(t)
	if resp, out := do(t, ts, "GET", "/v1.0/register/aabbccddeeff", "", nil); resp.StatusCode != 200 || out["result"] != true {
		t.Fatalf("register: status %d body %v", resp.StatusCode, out)
	}
	resp, out := do(t, ts, "GET", "/v1.0/recover/1234/aabbccddeeff", "", nil)
	token, _ := out["token"].(string)
	if resp.StatusCode != 200 || out["result"] != true || out["recovery"] != true || out["id"] != "aabbccddeeff" || !hexRe.MatchString(token) {
		t.Fatalf("recover: status %d body %v", resp.StatusCode, out)
	}
	for _, p := range []string{"/v1.0/register/nope", "/v1.0/recover/1234/nope"} {
		if resp, _ := do(t, ts, "GET", p, "", nil); resp.StatusCode != 404 {
			t.Errorf("%s: status %d", p, resp.StatusCode)
		}
	}
}

func TestStatusAnswersBootstrap(t *testing.T) {
	_, ts := newTest(t)
	resp, out := do(t, ts, "POST", "/v1.0/aabbccddeeff/0123abcd/status",
		`{"eth":"","wlan":"10.66.6.4","version":"smiirl-2.0.7-1","counter_type":"esp32"}`, http.Header{"Host": {"api.smiirl.com"}})
	if resp.StatusCode != 200 || out["result"] != true || out["status"] != true || out["url"] != "http://api.smiirl.com/aabbccddeeff/number" {
		t.Fatalf("status %d body %v", resp.StatusCode, out)
	}
	_, state := do(t, ts, "GET", "/api/state", "", nil)
	if state["device"].(map[string]any)["lastStatus"].(map[string]any)["wlan"] != "10.66.6.4" {
		t.Fatalf("state = %v", state)
	}
}

func TestSetValidation(t *testing.T) {
	_, ts := newTest(t)
	for _, tc := range []struct {
		body string
		want int
	}{
		{`{"number":0}`, 200},
		{`{"number":99999}`, 200},
		{`{"number":100000}`, 400},
		{`{"number":-1}`, 400},
		{`{"number":"abc"}`, 400},
		{`{"number":5,"cells":"aaaa5"}`, 400},
		{`{"cells":"1234"}`, 400},
		{`{"cells":"123456"}`, 400},
		{`{"cells":"aab0c"}`, 400},
		{`{"cells":"AAB02"}`, 400},
		{`{}`, 400},
		{`abc`, 400},
	} {
		resp, out := do(t, ts, "PUT", "/api/number", tc.body, nil)
		if resp.StatusCode != tc.want {
			t.Errorf("%s: status %d, want %d (%v)", tc.body, resp.StatusCode, tc.want, out)
		}
		if tc.want == 400 && out["error"] == nil {
			t.Errorf("%s: no error field", tc.body)
		}
	}
	if resp, out := do(t, ts, "POST", "/api/number", `{"number":42}`, nil); resp.StatusCode != 200 || out["number"] != float64(42) || out["cells"] != "aaa42" {
		t.Fatalf("POST: status %d body %v", resp.StatusCode, out)
	}
	_, state := do(t, ts, "GET", "/api/state", "", nil)
	if state["number"] != float64(42) || state["cells"] != "aaa42" || state["device"].(map[string]any)["online"] != false {
		t.Fatalf("state = %v", state)
	}
}

func TestCells(t *testing.T) {
	pollTimeout = 300 * time.Millisecond
	t.Cleanup(func() { pollTimeout = 12 * time.Second })
	_, ts := newTest(t)
	for _, tc := range []struct {
		cells  string
		number any // /api/state and /api/number
		device any // what the firmware is told
	}{
		{"aa302", float64(302), float64(302)},
		{"00302", nil, "00302"},
		{"aa3a2", nil, "aa3a2"},
		{"aaaa0", float64(0), float64(0)},
		{"bbbbb", nil, "bbbbb"},
		{"12345", float64(12345), float64(12345)},
		{"aaaaa", nil, "aaaaa"},
		{"14b30", nil, "14b30"},
	} {
		resp, out := do(t, ts, "PUT", "/api/number", `{"cells":"`+tc.cells+`"}`, nil)
		if resp.StatusCode != 200 || out["cells"] != tc.cells || out["number"] != tc.number {
			t.Errorf("%s: status %d body %v", tc.cells, resp.StatusCode, out)
		}
		if _, state := do(t, ts, "GET", "/api/state", "", nil); state["cells"] != tc.cells || state["number"] != tc.number {
			t.Errorf("%s: state %v", tc.cells, state)
		}
		if _, poll := do(t, ts, "GET", "/aabbccddeeff/number", "", nil); poll["number"] != tc.device {
			t.Errorf("%s: device got %v (%T), want %v", tc.cells, poll["number"], poll["number"], tc.device)
		}
	}
}

func TestLongPoll(t *testing.T) {
	pollTimeout = 300 * time.Millisecond
	t.Cleanup(func() { pollTimeout = 12 * time.Second })
	_, ts := newTest(t)

	start := time.Now()
	resp, out := do(t, ts, "GET", "/aabbccddeeff/number", "", nil)
	if resp.StatusCode != 200 || out["number"] != float64(0) {
		t.Fatalf("status %d body %v", resp.StatusCode, out)
	}
	if d := time.Since(start); d < pollTimeout {
		t.Fatalf("returned after %v without a change", d)
	}
	_, state := do(t, ts, "GET", "/api/state", "", nil)
	if dev := state["device"].(map[string]any); dev["online"] != true || dev["lastPoll"] == nil {
		t.Fatalf("device = %v", dev)
	}

	pollTimeout = 10 * time.Second
	do(t, ts, "PUT", "/api/number", `{"number":3}`, nil)
	start = time.Now()
	if _, out := do(t, ts, "GET", "/aabbccddeeff/number", "", nil); out["number"] != float64(3) || time.Since(start) > time.Second {
		t.Fatalf("poll after a set between polls = %v after %v", out, time.Since(start))
	}

	got := make(chan map[string]any, 1)
	go func() {
		_, out := do(t, ts, "GET", "/aabbccddeeff/number", "", nil)
		got <- out
	}()
	time.Sleep(50 * time.Millisecond)
	do(t, ts, "PUT", "/api/number", `{"number":7}`, nil)
	select {
	case out := <-got:
		if out["number"] != float64(7) {
			t.Fatalf("poll = %v", out)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("poll did not return early on change")
	}
}

func TestPersistence(t *testing.T) {
	dir := t.TempDir()
	s, err := newServer(dir, atlantic)
	if err != nil {
		t.Fatal(err)
	}
	if s.persisted.Cells != "aaaa0" || s.persisted.Daily.At != "08:00" {
		t.Fatalf("fresh dir: %+v", s.persisted)
	}
	if err := s.set("aa302"); err != nil {
		t.Fatal(err)
	}
	again, err := newServer(dir, atlantic)
	if err != nil {
		t.Fatal(err)
	}
	if again.persisted.Cells != "aa302" || again.persisted.UpdatedAt.IsZero() {
		t.Fatalf("reloaded = %+v", again.persisted)
	}

	if err := os.WriteFile(s.path, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	torn, err := newServer(dir, atlantic)
	if err != nil || torn.persisted.Cells != "aaaa0" {
		t.Fatalf("torn file: %v, %+v", err, torn)
	}

	if err := os.WriteFile(s.path, []byte(`{"number":302,"updatedAt":"2026-09-01T12:00:00Z"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	old, err := newServer(dir, atlantic)
	if err != nil || old.persisted.Cells != "aa302" || old.persisted.Daily.At != "08:00" || old.persisted.UpdatedAt.Year() != 2026 {
		t.Fatalf("migrated file: %v, %+v", err, old.persisted)
	}
}

func TestDueDays(t *testing.T) {
	for _, tc := range []struct {
		now, at, last string
		days          int
		upTo          string
	}{
		// 2026-09-06T11:00Z is 08:00 ADT.
		{"2026-09-06T10:59:59Z", "08:00", "", 0, "2026-09-05"},
		{"2026-09-06T11:00:00Z", "08:00", "", 1, "2026-09-06"},
		{"2026-09-06T11:00:00Z", "08:00", "2026-09-06", 0, "2026-09-06"},
		{"2026-09-06T11:00:00Z", "08:00", "2026-09-05", 1, "2026-09-06"},
		{"2026-09-06T11:00:00Z", "08:00", "2026-09-03", 3, "2026-09-06"},
		{"2026-09-06T10:59:59Z", "08:00", "2026-09-03", 2, "2026-09-05"},
		{"2026-09-06T11:00:00Z", "08:00", "2026-09-07", 0, "2026-09-06"},
		{"2026-09-06T11:00:00Z", "08:00", "2020-01-01", 366, "2026-09-06"},
		// 2026-09-07T02:59Z is still 23:59 ADT on the 6th.
		{"2026-09-07T02:59:59Z", "23:59", "", 1, "2026-09-06"},
		{"2026-09-07T03:00:00Z", "00:00", "2026-09-06", 1, "2026-09-07"},
		// Clocks sprang forward on 2026-03-08; two boundaries since the 7th.
		{"2026-03-09T11:00:00Z", "08:00", "2026-03-07", 2, "2026-03-09"},
	} {
		days, upTo := dueDays(utc(tc.now), atlantic, daily{Step: 1, At: tc.at, Last: tc.last})
		if days != tc.days || upTo != tc.upTo {
			t.Errorf("now %s at %s last %q: got %d up to %s, want %d up to %s", tc.now, tc.at, tc.last, days, upTo, tc.days, tc.upTo)
		}
	}
}

func TestDaily(t *testing.T) {
	s, ts := newTest(t)
	now := utc("2026-09-06T10:00:00Z") // 07:00 ADT
	s.now = func() time.Time { return now }

	resp, out := do(t, ts, "PUT", "/api/daily", `{"step":1,"at":"08:00"}`, nil)
	if resp.StatusCode != 200 || out["step"] != float64(1) || out["at"] != "08:00" || out["next"] != "2026-09-06T08:00:00-03:00" {
		t.Fatalf("daily: status %d body %v", resp.StatusCode, out)
	}
	do(t, ts, "PUT", "/api/number", `{"number":302}`, nil)

	cells := func() string {
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.persisted.Cells
	}
	step := func(at string, want string) {
		t.Helper()
		now = utc(at)
		s.tick()
		if got := cells(); got != want {
			t.Fatalf("at %s: cells %s, want %s (daily %+v)", at, got, want, s.persisted.Daily)
		}
	}
	step("2026-09-06T10:00:00Z", "aa302")
	step("2026-09-06T10:59:59Z", "aa302")
	step("2026-09-06T11:00:00Z", "aa303")
	step("2026-09-06T11:00:30Z", "aa303")

	// Moving at later on a day that already fired does not fire it twice.
	now = utc("2026-09-06T15:00:00Z") // 12:00 ADT
	if _, out = do(t, ts, "PUT", "/api/daily", `{"step":1,"at":"20:00"}`, nil); out["next"] != "2026-09-07T20:00:00-03:00" {
		t.Fatalf("next after moving at later = %v", out["next"])
	}
	step("2026-09-06T23:00:00Z", "aa303")
	now = utc("2026-09-06T23:30:00Z")
	do(t, ts, "PUT", "/api/daily", `{"step":1,"at":"08:00"}`, nil)
	step("2026-09-09T11:00:00Z", "aa306") // three missed days
	_, state := do(t, ts, "GET", "/api/state", "", nil)
	if d := state["daily"].(map[string]any); d["next"] != "2026-09-10T08:00:00-03:00" || state["number"] != float64(306) {
		t.Fatalf("state = %v", state)
	}

	do(t, ts, "PUT", "/api/daily", `{"step":5,"at":"08:00"}`, nil)
	do(t, ts, "PUT", "/api/number", `{"number":99998}`, nil)
	step("2026-09-09T12:00:00Z", "99998") // reconfigured after today's boundary: nothing owed
	step("2026-09-10T11:00:00Z", "99999")

	do(t, ts, "PUT", "/api/number", `{"cells":"bbbbb"}`, nil)
	step("2026-09-11T11:00:00Z", "bbbbb")
	if s.persisted.Daily.Last != "2026-09-11" {
		t.Fatalf("skipped day not recorded: %+v", s.persisted.Daily)
	}
	do(t, ts, "PUT", "/api/number", `{"number":0}`, nil)
	step("2026-09-12T11:00:00Z", "aaaa5")

	do(t, ts, "PUT", "/api/daily", `{"step":-10,"at":"08:00"}`, nil)
	step("2026-09-13T11:00:00Z", "aaaa0")

	again, err := newServer(s.path[:len(s.path)-len("/number.json")], atlantic)
	if err != nil || again.persisted.Daily != (daily{Step: -10, At: "08:00", Last: "2026-09-13"}) {
		t.Fatalf("reloaded daily: %v, %+v", err, again.persisted.Daily)
	}
}

func TestDailyValidation(t *testing.T) {
	_, ts := newTest(t)
	for _, tc := range []struct {
		body string
		want int
	}{
		{`{"step":0,"at":"08:00"}`, 200},
		{`{"step":-99999,"at":"00:00"}`, 200},
		{`{"step":99999,"at":"23:59"}`, 200},
		{`{"step":100000,"at":"08:00"}`, 400},
		{`{"step":-100000,"at":"08:00"}`, 400},
		{`{"step":1,"at":"8:00"}`, 400},
		{`{"step":1,"at":"24:00"}`, 400},
		{`{"step":1,"at":"08:60"}`, 400},
		{`{"step":1}`, 400},
		{`{"at":"08:00"}`, 400},
		{`{"step":"1","at":"08:00"}`, 400},
		{`nope`, 400},
	} {
		resp, out := do(t, ts, "PUT", "/api/daily", tc.body, nil)
		if resp.StatusCode != tc.want {
			t.Errorf("%s: status %d, want %d (%v)", tc.body, resp.StatusCode, tc.want, out)
		}
		if tc.want == 400 && out["error"] == nil {
			t.Errorf("%s: no error field", tc.body)
		}
	}
	if resp, out := do(t, ts, "POST", "/api/daily", `{"step":0,"at":"09:30"}`, nil); resp.StatusCode != 200 || out["next"] != nil || out["at"] != "09:30" {
		t.Fatalf("off: status %d body %v", resp.StatusCode, out)
	}
	_, state := do(t, ts, "GET", "/api/state", "", nil)
	if d := state["daily"].(map[string]any); d["step"] != float64(0) || d["at"] != "09:30" || d["next"] != nil {
		t.Fatalf("state daily = %v", d)
	}
}
