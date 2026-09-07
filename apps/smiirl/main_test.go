package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
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
	flapSettle = 0
	t.Cleanup(func() { flapSettle = 10 * time.Second })
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
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "application/json; charset=utf-8" {
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

	// Two different values are never handed over closer than flapSettle,
	// measured from the previous handover.
	handed := time.Now()
	flapSettle = 300 * time.Millisecond
	do(t, ts, "PUT", "/api/number", `{"number":4}`, nil)
	if _, out := do(t, ts, "GET", "/aabbccddeeff/number", "", nil); out["number"] != float64(4) || time.Since(handed) < flapSettle {
		t.Fatalf("second value handed over as %v %v after the first, before the flaps settled", out, time.Since(handed))
	}
	flapSettle = 0

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

func TestDeviceHostFacade(t *testing.T) {
	_, ts := newTest(t)
	dev := http.Header{"Host": {"api.smiirl.com"}}
	if _, out := do(t, ts, "GET", "/", "", dev); out["smiirl"] != "api" {
		t.Fatalf("GET / on the device host = %v", out)
	}
	if _, out := do(t, ts, "GET", "/number", "", dev); out["number"] != float64(1) {
		t.Fatalf("GET /number = %v", out)
	}
	// The check compares the reply literally with the cloud's 12 bytes.
	req, _ := http.NewRequest("GET", ts.URL+"/number", nil)
	req.Host = "api.smiirl.com"
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(raw) != `{"number":1}` || resp.Header.Get("Content-Length") != "12" || resp.Header.Get("Content-Type") != "application/json; charset=utf-8" {
		t.Fatalf("GET /number = %q, Content-Length %q, Content-Type %q", raw, resp.Header.Get("Content-Length"), resp.Header.Get("Content-Type"))
	}
	for _, p := range []string{"/status", "/update/firmware.bin", "/api/state", "/api/number"} {
		resp, out := do(t, ts, "GET", p, "", dev)
		if resp.StatusCode != 200 || out["api"] != "front" {
			t.Fatalf("GET %s on the device host = %d %v", p, resp.StatusCode, out)
		}
	}
	if resp, out := do(t, ts, "PUT", "/api/number", `{"number":5}`, dev); out["api"] != "front" {
		t.Fatalf("PUT /api/number on the device host = %d %v, must not be offered", resp.StatusCode, out)
	}
	if _, out := do(t, ts, "GET", "/api/state", "", nil); out["number"] != float64(0) {
		t.Fatalf("the page host still serves the API: %v", out)
	}
	resp, _ = do(t, ts, "GET", "/nope", "", nil)
	if resp.StatusCode != 404 {
		t.Fatalf("unknown path on the page host = %d, want 404", resp.StatusCode)
	}
	resp, _ = do(t, ts, "GET", "/", "", nil)
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Fatalf("GET / on the page host is %q, want the page", ct)
	}
}

func TestClockCells(t *testing.T) {
	for _, tc := range []struct {
		now, want, want12 string
	}{
		{"2026-09-06T12:05:00Z", "09b05", "a9b05"}, // 09:05 ADT
		{"2026-09-06T03:00:00Z", "00b00", "12b00"}, // midnight is 12 on a 12-hour clock
		{"2026-09-07T02:59:59Z", "23b59", "11b59"},
		{"2026-09-06T17:30:00Z", "14b30", "a2b30"},
		{"2026-09-06T15:00:00Z", "12b00", "12b00"}, // and so is noon
		{"2026-01-15T14:05:00Z", "10b05", "10b05"}, // AST
	} {
		if got := clockCells(utc(tc.now), atlantic, false); got != tc.want {
			t.Errorf("%s: %s, want %s", tc.now, got, tc.want)
		}
		if got := clockCells(utc(tc.now), atlantic, true); got != tc.want12 {
			t.Errorf("%s 12h: %s, want %s", tc.now, got, tc.want12)
		}
	}
}

func TestDaysCells(t *testing.T) {
	for _, tc := range []struct {
		now, date string
		days      int
		label     string
	}{
		{"2026-09-06T12:00:00Z", "2026-12-25", 110, "until"},
		{"2026-09-06T12:00:00Z", "2026-09-07", 1, "until"},
		{"2026-09-07T02:59:59Z", "2026-09-07", 1, "until"}, // still the 6th in Halifax
		{"2026-09-07T03:00:00Z", "2026-09-07", 0, "today"},
		{"2026-09-06T12:00:00Z", "2026-09-05", 1, "since"},
		{"2026-09-06T12:00:00Z", "2026-01-01", 248, "since"},
		// Clocks spring forward on 2026-03-08 and fall back on 2026-11-01:
		// whole days either way, never 23 or 25 hours rounded off.
		{"2026-03-07T15:00:00Z", "2026-03-08", 1, "until"},
		{"2026-03-07T15:00:00Z", "2026-03-09", 2, "until"},
		{"2026-03-09T15:00:00Z", "2026-03-07", 2, "since"},
		{"2026-03-08T03:30:00Z", "2026-03-08", 1, "until"}, // 23:30 AST on the 7th
		{"2026-10-31T15:00:00Z", "2026-11-02", 2, "until"},
		{"2026-11-02T15:00:00Z", "2026-10-31", 2, "since"},
		{"2026-09-06T12:00:00Z", "2999-01-01", 99999, "until"},
		{"2026-09-06T12:00:00Z", "1500-01-01", 99999, "since"},
	} {
		days, label, err := daysCells(utc(tc.now), atlantic, tc.date)
		if err != nil || days != tc.days || label != tc.label {
			t.Errorf("now %s date %s: %d %s %v, want %d %s", tc.now, tc.date, days, label, err, tc.days, tc.label)
		}
	}
	for _, bad := range []string{"", "2026-1-5", "2026-02-30", "25 Dec 2026", "2026-12-25T00:00:00Z"} {
		if _, _, err := daysCells(utc("2026-09-06T12:00:00Z"), atlantic, bad); err == nil {
			t.Errorf("%q: no error", bad)
		}
	}
}

func TestModeValidation(t *testing.T) {
	_, ts := newTest(t)
	for _, tc := range []struct {
		body string
		want int
	}{
		{`{"mode":"clock"}`, 200},
		{`{"mode":"clock","hour12":true}`, 200},
		{`{"mode":"clock","hour12":"yes"}`, 400},
		{`{"mode":"days","date":"2026-12-25"}`, 200},
		{`{"mode":"number"}`, 200},
		{`{"mode":"days"}`, 400},
		{`{"mode":"days","date":""}`, 400},
		{`{"mode":"days","date":"2026-1-5"}`, 400},
		{`{"mode":"days","date":"2026-02-30"}`, 400},
		{`{"mode":"weather"}`, 400},
		{`{"mode":""}`, 400},
		{`{}`, 400},
		{`{"mode":1}`, 400},
		{`nope`, 400},
	} {
		resp, out := do(t, ts, "PUT", "/api/mode", tc.body, nil)
		if resp.StatusCode != tc.want {
			t.Errorf("%s: status %d, want %d (%v)", tc.body, resp.StatusCode, tc.want, out)
		}
		if tc.want == 400 && out["error"] == nil {
			t.Errorf("%s: no error field", tc.body)
		}
	}
	// A rejected request leaves the mode alone.
	if _, state := do(t, ts, "GET", "/api/state", "", nil); state["mode"] != "number" {
		t.Fatalf("state = %v", state)
	}
}

func TestModes(t *testing.T) {
	s, ts := newTest(t)
	now := utc("2026-09-06T12:05:00Z") // 09:05 ADT
	s.now = func() time.Time { return now }
	do(t, ts, "PUT", "/api/number", `{"number":302}`, nil)

	_, state := do(t, ts, "GET", "/api/state", "", nil)
	if state["mode"] != "number" || state["display"] != "aa302" || state["cells"] != "aa302" || state["clock"].(map[string]any)["cells"] != "09b05" {
		t.Fatalf("number state = %v", state)
	}
	if d := state["days"].(map[string]any); d["date"] != "" || d["days"] != nil || d["label"] != nil {
		t.Fatalf("days with no date = %v", d)
	}

	resp, out := do(t, ts, "POST", "/api/mode", `{"mode":"clock"}`, nil)
	if resp.StatusCode != 200 || out["mode"] != "clock" || out["display"] != "09b05" {
		t.Fatalf("clock: status %d body %v", resp.StatusCode, out)
	}
	if _, poll := do(t, ts, "GET", "/aabbccddeeff/number", "", nil); poll["number"] != "09b05" {
		t.Fatalf("device in clock mode got %v", poll["number"])
	}
	// The stored number is untouched and still editable without leaving the mode.
	if resp, out := do(t, ts, "PUT", "/api/number", `{"number":303}`, nil); resp.StatusCode != 200 || out["cells"] != "aa303" {
		t.Fatalf("set in clock mode: status %d body %v", resp.StatusCode, out)
	}
	_, state = do(t, ts, "GET", "/api/state", "", nil)
	if state["mode"] != "clock" || state["display"] != "09b05" || state["number"] != float64(303) {
		t.Fatalf("clock state = %v", state)
	}

	// The 12-hour switch stands on its own: same mode, a different display.
	resp, out = do(t, ts, "PUT", "/api/mode", `{"mode":"clock","hour12":true}`, nil)
	if resp.StatusCode != 200 || out["display"] != "a9b05" || out["clock"].(map[string]any)["hour12"] != true {
		t.Fatalf("12-hour clock: status %d body %v", resp.StatusCode, out)
	}
	if _, poll := do(t, ts, "GET", "/aabbccddeeff/number", "", nil); poll["number"] != "a9b05" {
		t.Fatalf("device on a 12-hour clock got %v", poll["number"])
	}
	// It survives a mode round trip and clears when asked.
	do(t, ts, "PUT", "/api/mode", `{"mode":"number"}`, nil)
	_, state = do(t, ts, "GET", "/api/state", "", nil)
	if c := state["clock"].(map[string]any); c["hour12"] != true || c["cells"] != "a9b05" {
		t.Fatalf("clock view in number mode = %v", c)
	}
	resp, out = do(t, ts, "PUT", "/api/mode", `{"mode":"clock","hour12":false}`, nil)
	if resp.StatusCode != 200 || out["display"] != "09b05" {
		t.Fatalf("back to 24-hour: status %d body %v", resp.StatusCode, out)
	}

	resp, out = do(t, ts, "PUT", "/api/mode", `{"mode":"days","date":"2026-12-25"}`, nil)
	days, _ := out["days"].(map[string]any)
	if resp.StatusCode != 200 || out["mode"] != "days" || out["display"] != "aa110" || days["date"] != "2026-12-25" || days["days"] != float64(110) || days["label"] != "until" {
		t.Fatalf("days: status %d body %v", resp.StatusCode, out)
	}
	if _, poll := do(t, ts, "GET", "/aabbccddeeff/number", "", nil); poll["number"] != float64(110) {
		t.Fatalf("device in days mode got %v", poll["number"])
	}
	now = utc("2026-12-25T12:00:00Z")
	if _, state = do(t, ts, "GET", "/api/state", "", nil); state["display"] != "aaaa0" || state["days"].(map[string]any)["label"] != "today" {
		t.Fatalf("christmas state = %v", state)
	}
	now = utc("2026-12-30T12:00:00Z")
	if _, state = do(t, ts, "GET", "/api/state", "", nil); state["display"] != "aaaa5" || state["days"].(map[string]any)["label"] != "since" {
		t.Fatalf("after christmas state = %v", state)
	}

	// Back to number mode: the date is remembered for the page.
	if _, out = do(t, ts, "PUT", "/api/mode", `{"mode":"number"}`, nil); out["display"] != "aa303" || out["days"].(map[string]any)["date"] != "2026-12-25" {
		t.Fatalf("back to number = %v", out)
	}
	if _, poll := do(t, ts, "GET", "/aabbccddeeff/number", "", nil); poll["number"] != float64(303) {
		t.Fatalf("device back in number mode got %v", poll["number"])
	}

	again, err := newServer(s.path[:len(s.path)-len("/number.json")], atlantic)
	if err != nil || again.persisted.Mode != "number" || again.persisted.DaysDate != "2026-12-25" {
		t.Fatalf("reloaded: %v, %+v", err, again.persisted)
	}
}

func TestClockWakesPoll(t *testing.T) {
	pollTimeout = 10 * time.Second
	t.Cleanup(func() { pollTimeout = 12 * time.Second })
	s, ts := newTest(t)
	var mu sync.Mutex
	now := utc("2026-09-06T12:04:59.5Z") // 09:04:59.5 ADT
	s.now = func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		return now
	}
	do(t, ts, "PUT", "/api/mode", `{"mode":"clock"}`, nil)
	if _, poll := do(t, ts, "GET", "/aabbccddeeff/number", "", nil); poll["number"] != "09b04" {
		t.Fatalf("first poll = %v", poll["number"])
	}

	got := make(chan map[string]any, 1)
	go func() {
		_, out := do(t, ts, "GET", "/aabbccddeeff/number", "", nil)
		got <- out
	}()
	time.Sleep(50 * time.Millisecond)
	mu.Lock()
	now = utc("2026-09-06T12:05:00Z")
	mu.Unlock()
	select {
	case out := <-got:
		if out["number"] != "09b05" {
			t.Fatalf("poll = %v", out)
		}
	case <-time.After(1500 * time.Millisecond):
		t.Fatal("poll did not wake when the minute changed")
	}
}

func TestDailyStepsInClockMode(t *testing.T) {
	s, ts := newTest(t)
	now := utc("2026-09-06T10:00:00Z") // 07:00 ADT
	s.now = func() time.Time { return now }
	do(t, ts, "PUT", "/api/daily", `{"step":1,"at":"08:00"}`, nil)
	do(t, ts, "PUT", "/api/number", `{"number":302}`, nil)
	do(t, ts, "PUT", "/api/mode", `{"mode":"clock"}`, nil)
	now = utc("2026-09-06T11:00:00Z")
	s.tick()
	_, state := do(t, ts, "GET", "/api/state", "", nil)
	if state["mode"] != "clock" || state["number"] != float64(303) || state["cells"] != "aa303" || state["display"] != "08b00" {
		t.Fatalf("state = %v", state)
	}
}

func TestModeMigration(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/number.json"
	for _, tc := range []struct {
		file string
		mode string
		date string
	}{
		{`{"cells":"aa302","updatedAt":"2026-09-01T12:00:00Z","daily":{"step":0,"at":"08:00","last":""}}`, "number", ""},
		{`{"number":302,"updatedAt":"2026-09-01T12:00:00Z"}`, "number", ""},
		{`{"cells":"aa302","updatedAt":"2026-09-01T12:00:00Z","mode":"clock"}`, "clock", ""},
		{`{"cells":"aa302","updatedAt":"2026-09-01T12:00:00Z","mode":"clock","clock12":true}`, "clock", ""},
		{`{"cells":"aa302","updatedAt":"2026-09-01T12:00:00Z","mode":"days","daysDate":"2026-12-25"}`, "days", "2026-12-25"},
		{`{"cells":"aa302","updatedAt":"2026-09-01T12:00:00Z","mode":"days"}`, "number", ""},
		{`{"cells":"aa302","updatedAt":"2026-09-01T12:00:00Z","mode":"days","daysDate":"soon"}`, "number", ""},
		{`{"cells":"aa302","updatedAt":"2026-09-01T12:00:00Z","mode":"weather"}`, "number", ""},
	} {
		if err := os.WriteFile(path, []byte(tc.file), 0o644); err != nil {
			t.Fatal(err)
		}
		s, err := newServer(dir, atlantic)
		if err != nil || s.persisted.Cells != "aa302" || s.persisted.Mode != tc.mode || s.persisted.DaysDate != tc.date {
			t.Errorf("%s: %v, %+v", tc.file, err, s.persisted)
		}
	}
}
