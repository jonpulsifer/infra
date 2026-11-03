package netbox_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/jonpulsifer/infra/apps/fleetd/netbox"
	"github.com/jonpulsifer/infra/apps/fleetd/netbox/netboxtest"
)

func device(id int, name, serial, status string, cf map[string]any) map[string]any {
	fields := map[string]any{"class": map[string]any{"value": "worker-g5", "label": "worker-g5"}, "bmc_type": "amt"}
	for k, v := range cf {
		fields[k] = v
	}
	return map[string]any{
		"id": id, "name": name, "serial": serial,
		"status":        map[string]any{"value": status, "label": status},
		"primary_ip4":   map[string]any{"address": "10.3.0.12/26"},
		"oob_ip":        nil,
		"custom_fields": fields,
	}
}

func newClient(t *testing.T, f *netboxtest.Fake) *netbox.Client {
	t.Helper()
	f.T = t
	srv := httptest.NewServer(f.Handler())
	t.Cleanup(srv.Close)
	return &netbox.Client{URL: srv.URL, Token: "nbt_x.y", HTTP: srv.Client()}
}

func TestSelectValueShapes(t *testing.T) {
	cases := map[string]string{
		`"provision"`: "provision",
		`{"value":"provision","label":"Provision"}`: "provision",
		`null`: "",
		``:     "",
		`7`:    "",
	}
	for in, want := range cases {
		if got := netbox.SelectValue(json.RawMessage(in)); got != want {
			t.Errorf("SelectValue(%s) = %q, want %q", in, got, want)
		}
	}
}

func TestParseDeviceBMCAddress(t *testing.T) {
	raw, _ := json.Marshal(device(7, "riptide", "MXL", "active", nil))
	d, err := netbox.ParseDevice(raw)
	if err != nil {
		t.Fatal(err)
	}
	if d.BMCAddress != "10.3.0.12" || d.Address != "10.3.0.12" || d.Class != "worker-g5" || d.Status != "active" || d.DesiredAction != "none" {
		t.Fatalf("parsed %+v", d)
	}
	oob := device(7, "swell", "MXL", "planned", map[string]any{"bmc_type": map[string]any{"value": "amt"}})
	oob["oob_ip"] = map[string]any{"address": "10.4.0.5/24"}
	raw, _ = json.Marshal(oob)
	d, _ = netbox.ParseDevice(raw)
	if d.BMCType != "amt" || d.BMCAddress != "10.4.0.5" {
		t.Fatalf("oob_ip parsed %+v", d)
	}
	none := device(7, "shale", "MXL", "active", map[string]any{"bmc_type": "none"})
	raw, _ = json.Marshal(none)
	d, _ = netbox.ParseDevice(raw)
	if d.BMCAddress != "" {
		t.Fatalf("none has address %q", d.BMCAddress)
	}
}

func TestParseDeviceReadsTheAttestationFields(t *testing.T) {
	dev := device(7, "riptide", "MXL", "active", map[string]any{
		"ek_hash": "AA", "approved_ek_hash": "bb", "attest_verdict": "attested", "smbios_uuid": "ABC", "pcr0_by_bios": nil,
		"attested_switch": "AA:BB", "attested_switch_port": "Port 3", "attested_network_at": "2026-10-29T01:02:03Z",
	})
	dev["site"] = map[string]any{"id": 1, "slug": "folly"}
	dev["last_updated"] = "2026-10-29T01:02:03.5Z"
	raw, _ := json.Marshal(dev)
	d, err := netbox.ParseDevice(raw)
	if err != nil {
		t.Fatal(err)
	}
	if d.Site != "folly" || d.EKHash != "AA" || d.ApprovedEKHash != "bb" || d.Verdict != "attested" || d.SMBIOSUUID != "abc" ||
		d.Attested.Switch != "aa:bb" || d.Attested.Port != "Port 3" || d.Attested.At.IsZero() || d.LastUpdated.IsZero() {
		t.Fatalf("parsed %+v", d)
	}
	if d.Field("pcr0_by_bios") == nil || d.Field("dbx_hash") != nil {
		t.Fatalf("a null field is defined and an absent one is not: %v %v", d.Field("pcr0_by_bios"), d.Field("dbx_hash"))
	}
}

func TestPlain(t *testing.T) {
	for in, want := range map[string]string{
		"Port 7":                        "Port 7",
		"Port 7 **[pwn](http://x)**":    "Port 7    pwn  http://x",
		"`rack`|\\x\n<img src=y>~~_a_#": "rack   x  img src=y    a",
	} {
		if got := netbox.Plain(in); got != want {
			t.Errorf("Plain(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestValidMAC(t *testing.T) {
	for mac, want := range map[string]bool{"38:22:E2:2D:96:44": true, "38-22-e2-2d-96-44": true, "": false, "not-a-mac": false, "38:22:e2:2d:96": false, "3822.e22d.9644": false, "38:22:e2:2d:96:44\n": true} {
		if got := netbox.ValidMAC(mac); got != want {
			t.Errorf("ValidMAC(%q) = %v, want %v", mac, got, want)
		}
	}
}

func TestTokenSchemeAndErrorStatus(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("Authorization")
		http.Error(w, "nope", http.StatusForbidden)
	}))
	defer srv.Close()
	for token, want := range map[string]string{"nbt_a.b": "Bearer nbt_a.b", "legacy": "Token legacy"} {
		c := &netbox.Client{URL: srv.URL + "/", Token: token, HTTP: srv.Client()}
		err := c.Do(context.Background(), http.MethodGet, "/api/dcim/devices/", nil, nil)
		if got != want || netbox.StatusOf(err) != http.StatusForbidden {
			t.Errorf("token %q sent %q, status %d (%v)", token, got, netbox.StatusOf(err), err)
		}
	}
	if netbox.StatusOf(errors.New("other")) != 0 {
		t.Error("a plain error has a status")
	}
}

// The strict lookup demands exactly one hit; none is no device.
func TestSoleBySerial(t *testing.T) {
	f := &netboxtest.Fake{Devices: []map[string]any{
		device(1, "a", "ONE", "active", nil),
		device(2, "b", "TWO", "active", nil),
		device(3, "c", "two", "active", nil),
	}}
	c := newClient(t, f)
	if d, ok, err := c.SoleBySerial(context.Background(), "one"); err != nil || !ok || d.Name != "a" {
		t.Fatalf("one hit: %+v %v %v", d, ok, err)
	}
	if _, ok, err := c.SoleBySerial(context.Background(), "NOPE"); err != nil || ok {
		t.Fatalf("no hit: %v %v", ok, err)
	}
	if _, ok, err := c.SoleBySerial(context.Background(), "TWO"); err == nil || ok {
		t.Fatalf("two hits read as one: %v %v", ok, err)
	}
	empty := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("{}")) }))
	defer empty.Close()
	hollow := &netbox.Client{URL: empty.URL, Token: "nbt_x", HTTP: empty.Client()}
	if _, ok, err := hollow.SoleBySerial(context.Background(), "ANY"); err == nil || ok {
		t.Fatalf("an empty page read as no such device: %v %v", ok, err)
	}
}

func TestDevicesFollowsPagesAndFillsMACs(t *testing.T) {
	f := &netboxtest.Fake{PageSize: 2}
	for i := 1; i <= 5; i++ {
		f.Devices = append(f.Devices, device(i, string(rune('a'+i)), "S", "active", nil))
		f.Ifaces = append(f.Ifaces, map[string]any{"id": 10 + i, "device": map[string]any{"id": i}, "primary_mac_address": map[string]any{"mac_address": "AA:BB:CC:DD:EE:0" + string(rune('0'+i))}})
	}
	c := newClient(t, f)
	devices, err := c.Devices(context.Background(), url.Values{"site": {"folly"}})
	if err != nil || len(devices) != 5 {
		t.Fatalf("%d devices: %v", len(devices), err)
	}
	if err := c.WithInterfaces(context.Background(), devices); err != nil || devices[2].MAC != "aa:bb:cc:dd:ee:03" {
		t.Fatalf("MAC %q: %v", devices[2].MAC, err)
	}
}

func TestPatchAndJournal(t *testing.T) {
	f := &netboxtest.Fake{}
	c := newClient(t, f)
	ctx := context.Background()
	if err := c.Patch(ctx, 7, "", nil); err != nil || len(f.Patches) != 0 {
		t.Fatalf("an empty patch sent %d requests: %v", len(f.Patches), err)
	}
	if err := c.Patch(ctx, 7, "active", map[string]any{"desired_action": "none"}); err != nil {
		t.Fatal(err)
	}
	if p := f.Patches[0]; p["status"] != "active" || p["custom_fields"].(map[string]any)["desired_action"] != "none" || p["id"] != "7" {
		t.Fatalf("patch %+v", p)
	}
	if err := c.Journal(ctx, 7, "info", "hello"); err != nil {
		t.Fatal(err)
	}
	if j := f.Journals[0]; j["kind"] != "info" || j["comments"] != "hello" || j["assigned_object_type"] != "dcim.device" || j["assigned_object_id"] != float64(7) {
		t.Fatalf("journal %+v", j)
	}
}

func TestSwitchesNameTheirInterfaceMACs(t *testing.T) {
	f := &netboxtest.Fake{
		Switches: []map[string]any{{"id": 5, "name": "sw1"}},
		Ifaces:   []map[string]any{{"id": 1, "device": map[string]any{"id": 5}, "primary_mac_address": map[string]any{"mac_address": "F4:E2:C6:00:00:01"}}},
	}
	c := newClient(t, f)
	sw, err := c.Switches(context.Background(), "folly")
	if err != nil || len(sw) != 1 || !sw[0].MACs["f4:e2:c6:00:00:01"] {
		t.Fatalf("switches %+v: %v", sw, err)
	}
}

// A MAC write stands only when the interface ends up holding that one MAC
// as its primary: two anchors binding one stub cannot both win.
func TestSetMACRefusesASharedInterface(t *testing.T) {
	f := &netboxtest.Fake{
		Devices: []map[string]any{device(7, "swell", "SW-1", "planned", nil), device(8, "drift", "SW-2", "planned", nil)},
		Ifaces: []map[string]any{
			{"id": 1, "name": "eno1", "device": map[string]any{"id": 7}, "primary_mac_address": nil},
			{"id": 2, "name": "eno1", "device": map[string]any{"id": 8}, "primary_mac_address": nil},
		},
		MACs: []map[string]any{{"id": 90, "mac_address": "02:00:00:00:00:99", "assigned_object_type": "dcim.interface", "assigned_object_id": 2}},
	}
	c := newClient(t, f)
	ctx := context.Background()
	if wrote, err := c.SetMAC(ctx, 7, "02:00:00:00:00:01"); err != nil || !wrote {
		t.Fatalf("a sole MAC: %v %v", wrote, err)
	}
	if wrote, err := c.SetMAC(ctx, 7, "02:00:00:00:00:01"); err != nil || wrote {
		t.Fatalf("the same MAC again: %v %v", wrote, err)
	}
	if _, err := c.SetMAC(ctx, 7, "02:00:00:00:00:02"); !errors.Is(err, netbox.ErrMACTaken) {
		t.Fatalf("another MAC on a bound interface: %v", err)
	}
	if _, err := c.SetMAC(ctx, 8, "02:00:00:00:00:02"); !errors.Is(err, netbox.ErrMACTaken) {
		t.Fatalf("an interface another anchor wrote: %v", err)
	}
}

func TestSetMACMakesAnInterfaceWhenThereIsNone(t *testing.T) {
	f := &netboxtest.Fake{Devices: []map[string]any{device(7, "swell", "SW-1", "planned", nil)}}
	c := newClient(t, f)
	if wrote, err := c.SetMAC(context.Background(), 7, "02:00:00:00:00:01"); err != nil || !wrote {
		t.Fatalf("%v %v", wrote, err)
	}
	if len(f.Ifaces) != 1 || f.Ifaces[0]["name"] != "eth0" {
		t.Fatalf("interfaces %+v", f.Ifaces)
	}
}
