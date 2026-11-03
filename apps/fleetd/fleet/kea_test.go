package fleet

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

// fakeKeaSocket answers every command with the given result and counts them.
func fakeKeaSocket(t *testing.T, result int) (string, *atomic.Int32) {
	t.Helper()
	dir, err := os.MkdirTemp("", "kea")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	path := filepath.Join(dir, "kea.sock")
	l, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	var calls atomic.Int32
	go func() {
		for {
			conn, err := l.Accept()
			if err != nil {
				return
			}
			var cmd map[string]string
			if json.NewDecoder(conn).Decode(&cmd) == nil && cmd["command"] == "config-reload" {
				calls.Add(1)
			}
			_ = json.NewEncoder(conn).Encode(map[string]any{"result": result, "text": "Configuration successful."})
			conn.Close()
		}
	}()
	return path, &calls
}

func TestKeaReservationsWriteEachDeviceAndReloadOnce(t *testing.T) {
	socket, calls := fakeKeaSocket(t, 0)
	file := filepath.Join(t.TempDir(), "reservations.json")
	k := &KeaReservations{File: file, Socket: socket, BootFile: "talos/folly/ipxe.efi"}
	devices := []Device{
		{Name: "swell", MAC: "38:22:E2:2D:96:44", Address: "10.3.0.13"},
		{Name: "riptide", MAC: "ec:8e:b5:72:35:24", Address: "10.3.0.12"},
		{Name: "planned", Address: "10.3.0.20"},
		{Name: "nomac", MAC: ""},
	}
	if err := k.Sync(devices, map[string]bool{"riptide": true}); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var got []keaReservation
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	want := []keaReservation{
		{HWAddress: "ec:8e:b5:72:35:24", IPAddress: "10.3.0.12", Hostname: "riptide", BootFileName: "talos/folly/ipxe.efi"},
		{HWAddress: "38:22:e2:2d:96:44", IPAddress: "10.3.0.13", Hostname: "swell"},
	}
	if len(got) != len(want) {
		t.Fatalf("got %+v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("reservation %d: got %+v want %+v", i, got[i], want[i])
		}
	}
	if fi, _ := os.Stat(file); fi.Mode().Perm() != 0o640 {
		t.Errorf("mode %v", fi.Mode().Perm())
	}
	if calls.Load() != 1 {
		t.Fatalf("reloads after the first write: %d", calls.Load())
	}
	if err := k.Sync(devices, map[string]bool{"riptide": true}); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatalf("an unchanged file reloaded Kea: %d", calls.Load())
	}
	if err := k.Sync(devices, nil); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 {
		t.Fatalf("a finished run did not reload Kea: %d", calls.Load())
	}
	if body, _ := os.ReadFile(file); strings.Contains(string(body), "boot-file-name") {
		t.Error("the boot file stayed after the run finished")
	}
}

func TestKeaReservationsRefuseBadValuesAndFailedReloads(t *testing.T) {
	file := filepath.Join(t.TempDir(), "reservations.json")
	k := &KeaReservations{File: file, BootFile: "x"}
	err := k.Sync([]Device{
		{Name: "bad", MAC: "not-a-mac", Address: "10.3.0.9"},
		{Name: "six", MAC: "38:22:e2:2d:96:44", Address: "fe80::1"},
		{Name: "good", MAC: "ec:8e:b5:72:35:24", Address: "10.3.0.12"},
	}, nil)
	if err == nil || !strings.Contains(err.Error(), "not a MAC") || !strings.Contains(err.Error(), "not an IPv4 address") {
		t.Fatalf("bad values passed: %v", err)
	}
	body, _ := os.ReadFile(file)
	if !strings.Contains(string(body), "good") || strings.Contains(string(body), "bad") || strings.Contains(string(body), "six") {
		t.Errorf("the good device alone should be written:\n%s", body)
	}
	socket, _ := fakeKeaSocket(t, 1)
	k = &KeaReservations{File: filepath.Join(t.TempDir(), "r.json"), Socket: socket}
	if err := k.Sync([]Device{{Name: "good", MAC: "ec:8e:b5:72:35:24", Address: "10.3.0.12"}}, nil); err == nil || !strings.Contains(err.Error(), "result 1") {
		t.Fatalf("a refused reload passed: %v", err)
	}
	k = &KeaReservations{File: filepath.Join(t.TempDir(), "r.json"), Socket: filepath.Join(t.TempDir(), "missing.sock")}
	if err := k.Sync([]Device{{Name: "good", MAC: "ec:8e:b5:72:35:24", Address: "10.3.0.12"}}, nil); err == nil {
		t.Fatal("a missing socket passed")
	}
}

func TestKeaReservationsRetryAFailedReloadUntilItPasses(t *testing.T) {
	socket, calls := fakeKeaSocket(t, 0)
	k := &KeaReservations{File: filepath.Join(t.TempDir(), "r.json"), Socket: filepath.Join(t.TempDir(), "missing.sock")}
	devices := []Device{{Name: "good", MAC: "ec:8e:b5:72:35:24", Address: "10.3.0.12"}}
	if err := k.Sync(devices, nil); err == nil {
		t.Fatal("the first reload should fail")
	}
	k.Socket = socket
	if err := k.Sync(devices, nil); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatalf("the unchanged file was not reloaded after the failure: %d", calls.Load())
	}
	if err := k.Sync(devices, nil); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatalf("a passed reload was repeated: %d", calls.Load())
	}
}
