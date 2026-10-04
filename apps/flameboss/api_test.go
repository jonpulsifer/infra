package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

const (
	testDevice = 193415
	testCook   = 5242100
	testServer = "s2.myflameboss.com"
)

var cookStart = time.Date(2026, 10, 4, 20, 57, 52, 0, time.UTC)

func clockAt(s *State, t time.Time) {
	s.now = func() time.Time { return t }
}

func temps(cookID int, pit, set int, probes ...int) Temps {
	return Temps{Name: "temps", CookID: cookID, Temps: append([]int{pit}, probes...), SetTemp: set, Blower: 2850}
}

// A brisket two minutes in: two readings, a lid open, a pit alarm.
func liveCook(t *testing.T) *State {
	t.Helper()
	s := fixedState(t, cookStart)
	s.SetBrokerConnected(testServer, true)
	s.SeeDevice(testDevice, testServer)
	s.Labels(testDevice, []string{"Pit", "Flat", "Point", ""})
	s.MeatAlarm(testDevice, 1, "on")
	s.MeatAlarm(testDevice, 2, "off")
	s.Temps(testDevice, temps(testCook, 1100, 1211, 500, probeUnplugged, probeUnplugged))

	clockAt(s, cookStart.Add(90*time.Second))
	s.Lid(testDevice, true)
	s.MeatAlarmTriggered(testDevice, 1)
	clockAt(s, cookStart.Add(100*time.Second))
	s.PitAlarmTriggered(testDevice)
	clockAt(s, cookStart.Add(120*time.Second))
	s.Temps(testDevice, temps(testCook, 1215, 1211, 722, probeUnplugged, probeUnplugged))

	clockAt(s, cookStart.Add(128*time.Second))
	return s
}

func decoded(t *testing.T, v any) any {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func decodedJSON(t *testing.T, doc string) any {
	t.Helper()
	var out any
	if err := json.Unmarshal([]byte(doc), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func onlyCook(t *testing.T, s *State) CookSnapshot {
	t.Helper()
	snap := s.Snapshot()
	if len(snap.Devices) != 1 || snap.Devices[0].Cook == nil {
		t.Fatalf("snapshot has no single cook: %+v", snap)
	}
	return *snap.Devices[0].Cook
}

func TestSnapshotOfALiveCook(t *testing.T) {
	want := decodedJSON(t, `{
		"generated_at": "2026-10-04T21:00:00Z",
		"cloud_connected": true,
		"devices": [{
			"id": 193415,
			"online": true,
			"cook": {
				"id": 5242100,
				"active": true,
				"elapsed_seconds": 128,
				"quiet_seconds": 8,
				"pit_f": 250.7,
				"set_f": 250,
				"reached_set": true,
				"blower_pct": 28.5,
				"lid_open": true,
				"pit_alarm_seconds_ago": 28,
				"vent_advice_seconds_ago": null,
				"probes": [
					{"probe": 1, "label": "Flat", "temp_f": 162, "alarm_enabled": true, "alarm_triggered": true},
					{"probe": 2, "label": "Point", "temp_f": null, "alarm_enabled": false, "alarm_triggered": false},
					{"probe": 3, "label": "", "temp_f": null, "alarm_enabled": null, "alarm_triggered": false}
				],
				"history": {
					"step_seconds": 60,
					"pit_f": [230, null, 250.7],
					"set_f": [250, null, 250],
					"probes_f": [[122, null, 162], [null, null, null], [null, null, null]]
				}
			}
		}]
	}`)

	got := decoded(t, liveCook(t).Snapshot())

	if !reflect.DeepEqual(got, want) {
		gotJSON, _ := json.MarshalIndent(got, "", "  ")
		wantJSON, _ := json.MarshalIndent(want, "", "  ")
		t.Errorf("snapshot differs\ngot:\n%s\nwant:\n%s", gotJSON, wantJSON)
	}
}

// The display reads these names, so a rename or an omitted null fails here
// before it reaches the Tidbyt.
func TestSnapshotUsesTheContractsFieldNames(t *testing.T) {
	const (
		documentKeys = "cloud_connected devices generated_at"
		deviceKeys   = "cook id online"
		cookKeys     = "active blower_pct elapsed_seconds history id lid_open pit_alarm_seconds_ago " +
			"pit_f probes quiet_seconds reached_set set_f vent_advice_seconds_ago"
		probeKeys   = "alarm_enabled alarm_triggered label probe temp_f"
		historyKeys = "pit_f probes_f set_f step_seconds"
	)
	keys := func(v any) string {
		var out []string
		for k := range v.(map[string]any) {
			out = append(out, k)
		}
		sort.Strings(out)
		return strings.Join(out, " ")
	}
	check := func(level string, v any, want string) {
		t.Helper()
		if got := keys(v); got != want {
			t.Errorf("%s keys = %s, want %s", level, got, want)
		}
	}

	idle := fixedState(t, cookStart)
	idle.SeeDevice(testDevice, testServer)
	for _, s := range []*State{liveCook(t), idle} {
		doc := decoded(t, s.Snapshot())
		check("document", doc, documentKeys)
		device := doc.(map[string]any)["devices"].([]any)[0]
		check("device", device, deviceKeys)

		cook := device.(map[string]any)["cook"]
		if cook == nil {
			continue
		}
		check("cook", cook, cookKeys)
		for _, probe := range cook.(map[string]any)["probes"].([]any) {
			check("probe", probe, probeKeys)
		}
		check("history", cook.(map[string]any)["history"], historyKeys)
	}
}

func TestSnapshotBeforeAnyDeviceIsKnown(t *testing.T) {
	s := fixedState(t, cookStart)
	snap := s.Snapshot()
	if snap.CloudConnected || snap.Devices == nil || len(snap.Devices) != 0 {
		t.Errorf("empty snapshot = %+v, want disconnected with an empty, non-nil device list", snap)
	}
	raw, _ := json.Marshal(snap)
	if !strings.Contains(string(raw), `"devices":[]`) {
		t.Errorf("devices encode as %s, want []", raw)
	}
}

func TestSnapshotCloudConnectedMeansAnyServerIsUp(t *testing.T) {
	s := fixedState(t, cookStart)
	s.SetBrokerConnected("myflameboss.com", false)
	if s.Snapshot().CloudConnected {
		t.Error("cloud_connected with every server down")
	}
	s.SetBrokerConnected(testServer, true)
	if !s.Snapshot().CloudConnected {
		t.Error("cloud_connected with one server up")
	}
}

func TestSnapshotListsDevicesByIDWithAndWithoutACook(t *testing.T) {
	s := fixedState(t, cookStart)
	s.SeeDevice(30, testServer)
	s.SeeDevice(7, testServer)
	s.Temps(30, temps(1, 1100, 1211))
	s.SetDeviceOnline(30, false)

	var got []string
	for _, d := range s.Snapshot().Devices {
		got = append(got, strings.Join([]string{
			strconv.Itoa(d.ID), strconv.FormatBool(d.Online), strconv.FormatBool(d.Cook != nil),
		}, "/"))
	}
	if want := []string{"7/true/false", "30/false/true"}; !slices.Equal(got, want) {
		t.Errorf("devices (id/online/has cook) = %v, want %v", got, want)
	}
}

func TestSnapshotUnpluggedProbesAreNull(t *testing.T) {
	s := fixedState(t, cookStart)
	s.Temps(testDevice, temps(testCook, 1100, 1211, 500, 600, 700))
	clockAt(s, cookStart.Add(time.Minute))
	s.Temps(testDevice, temps(testCook, probeUnplugged, 1211, probeUnplugged, 600))

	c := onlyCook(t, s)

	if c.PitF != nil {
		t.Errorf("pit_f with the pit probe unplugged = %v, want null", *c.PitF)
	}
	if c.ReachedSet {
		t.Error("reached_set from a pit that never came to set")
	}
	var temp []*float64
	for _, p := range c.Probes {
		temp = append(temp, p.TempF)
	}
	if temp[0] != nil || temp[1] == nil || *temp[1] != 140 || temp[2] != nil {
		t.Errorf("probe temps = %v, want null, 140, null", deref(temp))
	}
	if got := deref(c.History.PitF); !slices.Equal(got, []string{"230", "null"}) {
		t.Errorf("pit history = %v, want the plugged reading then null", got)
	}
	if got := deref(c.History.ProbesF[0]); !slices.Equal(got, []string{"122", "null"}) {
		t.Errorf("probe 1 history = %v, want the plugged reading then null", got)
	}
	if got := deref(c.History.SetF); !slices.Equal(got, []string{"250", "250"}) {
		t.Errorf("set history = %v, want 250 twice", got)
	}
}

// A controller that has sent no temperatures yet has a pit of 0 decidegrees in
// the state, which would read as 32 F.
func TestSnapshotEmptyTempsReadAsUnplugged(t *testing.T) {
	s := fixedState(t, cookStart)
	s.Temps(testDevice, Temps{Name: "temps", CookID: testCook, SetTemp: 1211})

	c := onlyCook(t, s)

	if c.PitF != nil || c.Probes[0].TempF != nil {
		t.Errorf("pit %v, probe 1 %v, want null for both", c.PitF, c.Probes[0].TempF)
	}
	if got := deref(c.History.PitF); !slices.Equal(got, []string{"null"}) {
		t.Errorf("pit history = %v, want null", got)
	}
	if got := deref(c.History.SetF); !slices.Equal(got, []string{"250"}) {
		t.Errorf("set history = %v, want 250", got)
	}
}

func TestSnapshotAlarmsAreUnknownUntilTheControllerReportsThem(t *testing.T) {
	s := fixedState(t, cookStart)
	s.Temps(testDevice, temps(testCook, 1100, 1211))
	enabled := func() []string {
		var out []string
		for _, p := range onlyCook(t, s).Probes {
			out = append(out, boolOrNull(p.AlarmEnabled))
		}
		return out
	}

	if got := enabled(); !slices.Equal(got, []string{"null", "null", "null"}) {
		t.Errorf("alarm_enabled before any report = %v, want all null", got)
	}
	s.MeatAlarm(testDevice, 1, "keep_warm")
	s.MeatAlarm(testDevice, 3, "off")
	if got := enabled(); !slices.Equal(got, []string{"true", "null", "false"}) {
		t.Errorf("alarm_enabled after reports = %v, want true, null, false", got)
	}
}

func TestSnapshotLabelsFollowTheController(t *testing.T) {
	s := fixedState(t, cookStart)
	s.Temps(testDevice, temps(testCook, 1100, 1211))
	labels := func() []string {
		var out []string
		for _, p := range onlyCook(t, s).Probes {
			out = append(out, p.Label)
		}
		return out
	}

	if got := labels(); !slices.Equal(got, []string{"", "", ""}) {
		t.Errorf("labels before the controller named them = %q, want empty", got)
	}
	s.Labels(testDevice, []string{"Pit", "Brisket", "", "Butt"})
	if got := labels(); !slices.Equal(got, []string{"Brisket", "", "Butt"}) {
		t.Errorf("labels = %q, want Brisket, empty, Butt", got)
	}
}

func TestSnapshotEventsAreNullUntilTheyHappenThisCook(t *testing.T) {
	s := fixedState(t, cookStart)
	s.Temps(testDevice, temps(testCook, 1100, 1211))

	c := onlyCook(t, s)
	if c.PitAlarmSecondsAgo != nil || c.VentAdviceSecondsAgo != nil {
		t.Fatalf("events before any fired: pit %v, vent %v, want null", c.PitAlarmSecondsAgo, c.VentAdviceSecondsAgo)
	}

	clockAt(s, cookStart.Add(40*time.Second))
	s.VentAdvice(testDevice)
	clockAt(s, cookStart.Add(95*time.Second))
	s.PitAlarmTriggered(testDevice)
	clockAt(s, cookStart.Add(135*time.Second))
	c = onlyCook(t, s)
	if c.VentAdviceSecondsAgo == nil || *c.VentAdviceSecondsAgo != 95 || c.PitAlarmSecondsAgo == nil || *c.PitAlarmSecondsAgo != 40 {
		t.Errorf("seconds ago: vent %v, pit %v, want 95 and 40", c.VentAdviceSecondsAgo, c.PitAlarmSecondsAgo)
	}

	s.Temps(testDevice, temps(testCook+1, 1100, 1211))
	c = onlyCook(t, s)
	if c.PitAlarmSecondsAgo != nil || c.VentAdviceSecondsAgo != nil {
		t.Errorf("events on a new cook: pit %v, vent %v, want null", c.PitAlarmSecondsAgo, c.VentAdviceSecondsAgo)
	}
}

func TestSnapshotQuietControllerIsInactiveWithTrailingNulls(t *testing.T) {
	s := fixedState(t, cookStart)
	s.Temps(testDevice, temps(testCook, 1100, 1211, 500))
	clockAt(s, cookStart.Add(6*time.Minute))

	c := onlyCook(t, s)

	if c.Active {
		t.Error("active after six quiet minutes")
	}
	if c.QuietSeconds != 360 || c.ElapsedSeconds != 360 {
		t.Errorf("quiet %ds, elapsed %ds, want 360 for both", c.QuietSeconds, c.ElapsedSeconds)
	}
	h := c.History
	lengths := []int{len(h.PitF), len(h.SetF), len(h.ProbesF[0]), len(h.ProbesF[1]), len(h.ProbesF[2])}
	if want := []int{7, 7, 7, 7, 7}; !slices.Equal(lengths, want) {
		t.Fatalf("history lengths = %v, want %v, the last bucket being now", lengths, want)
	}
	if got := deref(h.PitF); !slices.Equal(got, []string{"230", "null", "null", "null", "null", "null", "null"}) {
		t.Errorf("pit history = %v, want one reading then trailing nulls", got)
	}

	// Reading the snapshot must not move the record on.
	clockAt(s, cookStart.Add(7*time.Minute))
	s.Temps(testDevice, temps(testCook, 1215, 1211, 500))
	if got := deref(onlyCook(t, s).History.PitF); len(got) != 8 || got[7] != "250.7" {
		t.Errorf("pit history after the controller returned = %v, want 8 buckets ending 250.7", got)
	}
}

func TestSnapshotRetiresACookWhenCollectDoes(t *testing.T) {
	for _, tc := range []struct {
		quiet   time.Duration
		present bool
	}{
		{29 * time.Minute, true},
		{30 * time.Minute, true},
		{30*time.Minute + time.Second, false},
	} {
		build := func() *State {
			s := fixedState(t, cookStart)
			s.SeeDevice(testDevice, testServer)
			s.Temps(testDevice, temps(testCook, 1100, 1211))
			clockAt(s, cookStart.Add(tc.quiet))
			return s
		}

		snap := build().Snapshot()
		if len(snap.Devices) != 1 || (snap.Devices[0].Cook != nil) != tc.present {
			t.Errorf("snapshot after %v of quiet: cook present = %v, want %v", tc.quiet, snap.Devices[0].Cook != nil, tc.present)
		}
		if got := testutil.CollectAndCount(build(), "flameboss_cook"); (got == 1) != tc.present {
			t.Errorf("flameboss_cook series after %v of quiet = %d, want present = %v", tc.quiet, got, tc.present)
		}
		if snap.Devices[0].ID != testDevice || !snap.Devices[0].Online {
			t.Errorf("the device must outlive its cook: %+v", snap.Devices[0])
		}
	}
}

func TestSnapshotNewCookStartsAFreshHistory(t *testing.T) {
	s := fixedState(t, cookStart)
	for m := 0; m < 10; m++ {
		clockAt(s, cookStart.Add(time.Duration(m)*time.Minute))
		s.Temps(testDevice, temps(testCook, 1100+m, 1211, 500))
	}
	if n := len(onlyCook(t, s).History.PitF); n != 10 {
		t.Fatalf("history of the first cook has %d buckets, want 10", n)
	}

	clockAt(s, cookStart.Add(11*time.Minute))
	s.Temps(testDevice, temps(testCook+1, 600, 1211))
	c := onlyCook(t, s)

	if c.ID != testCook+1 || c.ElapsedSeconds != 0 {
		t.Errorf("cook %d at %ds, want a new cook at 0s", c.ID, c.ElapsedSeconds)
	}
	if got := deref(c.History.PitF); !slices.Equal(got, []string{"140"}) {
		t.Errorf("pit history = %v, want only the new cook's first reading", got)
	}
	if got := deref(c.History.ProbesF[0]); !slices.Equal(got, []string{"null"}) {
		t.Errorf("probe 1 history = %v, want nothing carried over", got)
	}
}

func TestSnapshotHistoryStaysBoundedOnALongCook(t *testing.T) {
	s := fixedState(t, cookStart)
	var minutes time.Duration
	for ; minutes <= 240; minutes++ {
		clockAt(s, cookStart.Add(minutes*time.Minute))
		s.Temps(testDevice, temps(testCook, 1000+int(minutes), 1211, 500))
	}

	c := onlyCook(t, s)
	h := c.History

	if h.StepSeconds != 120 {
		t.Errorf("step_seconds = %d, want 120 after the 240th bucket", h.StepSeconds)
	}
	for name, n := range map[string]int{
		"pit_f": len(h.PitF), "set_f": len(h.SetF),
		"probe 1": len(h.ProbesF[0]), "probe 2": len(h.ProbesF[1]), "probe 3": len(h.ProbesF[2]),
	} {
		if n != 121 {
			t.Errorf("%s has %d buckets, want 121", name, n)
		}
	}
	if last := h.PitF[len(h.PitF)-1]; last == nil || *last != *c.PitF {
		t.Errorf("newest history bucket = %v, want the live pit %v", last, *c.PitF)
	}
}

func TestSnapshotRoundsToTenthsOfAFahrenheitDegree(t *testing.T) {
	s := fixedState(t, cookStart)
	s.Temps(testDevice, temps(testCook, 1306, 1212, 749))

	c := onlyCook(t, s)

	if *c.PitF != 267.1 || c.SetF != 250.2 || *c.Probes[0].TempF != 166.8 {
		t.Errorf("pit %v, set %v, probe 1 %v, want 267.1, 250.2, 166.8", *c.PitF, c.SetF, *c.Probes[0].TempF)
	}
}

func TestCookHandler(t *testing.T) {
	h := cookHandler(liveCook(t))

	t.Run("GET serves the snapshot as JSON", func(t *testing.T) {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/cook", nil))

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		if got := rec.Header().Get("Content-Type"); got != "application/json" {
			t.Errorf("Content-Type = %q, want application/json", got)
		}
		var snap Snapshot
		if err := json.NewDecoder(rec.Body).Decode(&snap); err != nil {
			t.Fatal(err)
		}
		if snap.GeneratedAt != "2026-10-04T21:00:00Z" || len(snap.Devices) != 1 || snap.Devices[0].Cook == nil {
			t.Errorf("decoded body = %+v, want the live cook", snap)
		}
	})

	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodHead} {
		t.Run(method+" is refused", func(t *testing.T) {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(method, "/api/cook", nil))

			if rec.Code != http.StatusMethodNotAllowed {
				t.Errorf("status = %d, want 405", rec.Code)
			}
			if got := rec.Header().Get("Allow"); got != http.MethodGet {
				t.Errorf("Allow = %q, want GET", got)
			}
		})
	}
}

func deref(values []*float64) []string {
	out := make([]string, len(values))
	for i, v := range values {
		out[i] = "null"
		if v != nil {
			out[i] = strconv.FormatFloat(*v, 'f', -1, 64)
		}
	}
	return out
}

func boolOrNull(b *bool) string {
	if b == nil {
		return "null"
	}
	return strconv.FormatBool(*b)
}
