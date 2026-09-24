package main

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

func TestUserIDIsTheUsernameWithoutItsPrefix(t *testing.T) {
	if got := (Options{Username: "T-235193"}).UserID(); got != "235193" {
		t.Errorf("UserID = %q, want 235193", got)
	}
}

func TestSendTopicsAreExplicit(t *testing.T) {
	want := []string{"flameboss/193415/send/open", "flameboss/193415/send/data"}
	if got := sendTopics(193415); !reflect.DeepEqual(got, want) {
		t.Errorf("sendTopics = %v, want %v", got, want)
	}
}

func TestDeviceFromTopic(t *testing.T) {
	for topic, want := range map[string]int{
		"flameboss/193415/send/open": 193415,
		"flameboss/193415/send/data": 193415,
		"flameboss/193415/recv":      193415,
	} {
		got, ok := deviceFromTopic(topic)
		if !ok || got != want {
			t.Errorf("deviceFromTopic(%q) = %d, %v; want %d, true", topic, got, ok, want)
		}
	}
	for _, topic := range []string{"user/235193/recv", "flameboss/abc/send/open", "flameboss", ""} {
		if _, ok := deviceFromTopic(topic); ok {
			t.Errorf("deviceFromTopic(%q) claimed a device", topic)
		}
	}
}

func TestAllowedServer(t *testing.T) {
	r := &Relay{opts: Options{Host: "myflameboss.com"}}
	for server, want := range map[string]bool{
		"s2.myflameboss.com":      true,
		"myflameboss.com":         true,
		"s2.myflameboss.com.evil": false,
		"evil.com":                false,
		"notmyflameboss.com":      false,
	} {
		if got := r.allowedServer(server); got != want {
			t.Errorf("allowedServer(%q) = %v, want %v", server, got, want)
		}
	}
	// A simulator or LAN broker has no domain to compare against.
	local := &Relay{opts: Options{Host: "localhost"}}
	if !local.allowedServer("anything") {
		t.Error("a bare hostname should accept the server it is told")
	}
}

func TestControlMessageShapes(t *testing.T) {
	var deviceless control
	if err := json.Unmarshal([]byte(`{"name":"connected","server":"s2.myflameboss.com"}`), &deviceless); err != nil {
		t.Fatal(err)
	}
	if deviceless.DeviceID != nil {
		t.Error("a device-less connected must not decode a device id")
	}

	var withDevice control
	if err := json.Unmarshal([]byte(`{"name":"connected","server":"s2.myflameboss.com","device_id":193415}`), &withDevice); err != nil {
		t.Fatal(err)
	}
	if withDevice.DeviceID == nil || *withDevice.DeviceID != 193415 {
		t.Errorf("device id = %v, want 193415", withDevice.DeviceID)
	}
}

// Captured from a live controller.
func TestTempsDecodesTheWirePayload(t *testing.T) {
	const payload = `{"name":"temps","cook_id":5242100,"sec":1789943581,"temps":[1305,-32767,-32767,-32767],"set_temp":1212,"blower":0}`
	var got Temps
	if err := json.Unmarshal([]byte(payload), &got); err != nil {
		t.Fatal(err)
	}
	want := Temps{Name: "temps", CookID: 5242100, Sec: 1789943581,
		Temps: []int{1305, -32767, -32767, -32767}, SetTemp: 1212, Blower: 0}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Temps = %+v, want %+v", got, want)
	}
}

func testRelay(t *testing.T, s *State) (*Relay, *bytes.Buffer) {
	t.Helper()
	var logs bytes.Buffer
	return &Relay{
		state:  s,
		log:    slog.New(slog.NewJSONHandler(&logs, nil)),
		logged: map[string]bool{},
	}, &logs
}

func TestApplyModelledUplinks(t *testing.T) {
	s := NewState(5*time.Minute, 30*time.Minute)
	s.now = func() time.Time { return time.Unix(1000, 0) }
	r, _ := testRelay(t, s)

	for _, p := range []string{
		`{"name":"temps","cook_id":7,"sec":1000,"temps":[1072,749,-32767,-32767],"set_temp":1072,"blower":2500}`,
		`{"name":"labels","values":["Pit","Brisket","Butt","Turkey"]}`,
		`{"name":"meat_alarm","sensor":1,"action":"on","done_temp":203,"warm_temp":170}`,
		`{"name":"pit_alarm","enabled":true,"range":25}`,
		`{"name":"dc_input","value":120}`,
		`{"name":"opened"}`,
		`{"name":"meat_alarm_triggered","sensor":1}`,
		`{"name":"vent_advice"}`,
	} {
		var name struct{ Name string }
		if err := json.Unmarshal([]byte(p), &name); err != nil {
			t.Fatal(err)
		}
		if err := r.apply(1, name.Name, []byte(p)); err != nil {
			t.Fatalf("apply %s: %v", name.Name, err)
		}
	}

	for metric, want := range map[string]float64{
		"flameboss_meat_alarm_enabled":            1,
		"flameboss_pit_alarm_enabled":             1,
		"flameboss_supply_volts":                  12,
		"flameboss_lid_open":                      1,
		"flameboss_meat_alarm_triggered":          1,
		"flameboss_vent_advice_timestamp_seconds": 1000,
	} {
		if got := only(t, s, metric); got != want {
			t.Errorf("%s = %v, want %v", metric, got, want)
		}
	}
	if got := testutil.CollectAndCount(s, "flameboss_probe_info"); got != 3 {
		t.Errorf("probe_info series = %d, want 3", got)
	}
}

func TestEvidenceIsLoggedOnceAndNeverForWifi(t *testing.T) {
	r, logs := testRelay(t, NewState(5*time.Minute, 30*time.Minute))
	r.logFirst(1, "meat_alarm", []byte(`{"name":"meat_alarm","sensor":1,"done_temp":950}`))
	r.logFirst(1, "meat_alarm", []byte(`{"name":"meat_alarm","sensor":2,"done_temp":740}`))
	r.logFirst(1, "wifi", []byte(`{"name":"wifi","ssid":"home","key":"hunter2"}`))

	out := logs.String()
	if n := strings.Count(out, `"name":"meat_alarm"`); n != 1 {
		t.Errorf("meat_alarm logged %d times, want once:\n%s", n, out)
	}
	if !strings.Contains(out, `done_temp\":950`) {
		t.Errorf("the first meat_alarm payload is not in the log:\n%s", out)
	}
	if strings.Contains(out, "hunter2") || strings.Contains(out, "wifi") {
		t.Errorf("a wifi payload reached the log:\n%s", out)
	}
}
