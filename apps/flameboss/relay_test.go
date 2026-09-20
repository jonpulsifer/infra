package main

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestUserIDIsTheUsernameWithoutItsPrefix(t *testing.T) {
	if got := (Options{Username: "T-235193"}).UserID(); got != "235193" {
		t.Errorf("UserID = %q, want 235193", got)
	}
}

func TestSendTopicsAreExplicit(t *testing.T) {
	// Not `flameboss/<id>/send/#`: the broker accepts the wildcard and
	// delivers nothing on it.
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

// The control plane decides where this process sends the account's
// credentials, so a `server` outside the broker's own domain is refused.
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

// The two shapes of `connected` mean different things: one names the server
// this connection landed on, the other names a device's server.
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

// The live payload, byte for byte as the cooker publishes it.
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
