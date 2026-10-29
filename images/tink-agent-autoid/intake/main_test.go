package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// fakeSys lays out the sysfs of an EliteDesk in HookOS: Docker's bridge, a NIC without carrier, the
// netbooted NIC, an NVMe disk, a SATA disk, a USB stick, a loop device and an empty optical drive.
func fakeSys(t *testing.T) string {
	t.Helper()
	sys := t.TempDir()
	file := func(path, content string) {
		t.Helper()
		full := filepath.Join(sys, path)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	link := func(target, path string) {
		t.Helper()
		full := filepath.Join(sys, path)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(filepath.Join(sys, target), full); err != nil {
			t.Fatal(err)
		}
	}
	dir := func(path string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Join(sys, path), 0o755); err != nil {
			t.Fatal(err)
		}
	}

	file("class/dmi/id/product_serial", "CZC0000TST\n")
	file("class/dmi/id/product_uuid", "0D8C8F2E-1C3B-4A5D-9E6F-7A8B9C0D1E2F\n")
	file("class/dmi/id/product_name", "HP EliteDesk 800 G5 Desktop Mini\n")
	file("class/dmi/id/product_sku", "7PF33AV\n")
	file("class/dmi/id/bios_version", "R21 Ver. 02.19.00\n")

	file("devices/virtual/net/lo/address", "00:00:00:00:00:00\n")
	file("devices/virtual/net/docker0/address", "02:42:ac:11:00:01\n")
	file("devices/virtual/net/docker0/carrier", "1\n")
	for nic, mac := range map[string]string{"eno1": "aa:bb:cc:00:00:01", "enp3s0": "aa:bb:cc:00:00:02"} {
		pci := "devices/pci0000:00/0000:00:1f.6/net/" + nic
		file(pci+"/address", mac+"\n")
		dir(pci + "/device")
		link(pci, "class/net/"+nic)
	}
	file("devices/pci0000:00/0000:00:1f.6/net/enp3s0/carrier", "1\n")
	link("devices/virtual/net/lo", "class/net/lo")
	link("devices/virtual/net/docker0", "class/net/docker0")

	block := map[string]string{
		"nvme0n1": "devices/pci0000:00/0000:00:1d.0/0000:6e:00.0/nvme/nvme0/nvme0n1",
		"sda":     "devices/pci0000:00/0000:00:17.0/ata1/host0/target0:0:0/0:0:0:0/block/sda",
		"sdb":     "devices/pci0000:00/0000:00:14.0/usb2/2-1/2-1:1.0/host1/target1:0:0/1:0:0:0/block/sdb",
		"sr0":     "devices/pci0000:00/0000:00:17.0/ata2/host2/target2:0:0/2:0:0:0/block/sr0",
	}
	sizes := map[string]string{"nvme0n1": "1000215216", "sda": "976773168", "sdb": "60088320", "sr0": "0"}
	for name, path := range block {
		file(path+"/size", sizes[name]+"\n")
		dir(path + "/device")
		link(path, "block/"+name)
	}
	file("devices/virtual/block/loop0/size", "409600\n")
	link("devices/virtual/block/loop0", "block/loop0")
	return sys
}

func TestCollectReadsTheMachine(t *testing.T) {
	got := collect(fakeSys(t), "")
	want := Facts{
		MAC:    "aa:bb:cc:00:00:02",
		Serial: "CZC0000TST",
		UUID:   "0d8c8f2e-1c3b-4a5d-9e6f-7a8b9c0d1e2f",
		Model:  "HP EliteDesk 800 G5 Desktop Mini",
		SKU:    "7PF33AV",
		BIOS:   "R21 Ver. 02.19.00",
		Disks: []Disk{
			{Name: "nvme0n1", Size: 512110190592, Tran: "nvme"},
			{Name: "sda", Size: 500107862016, Tran: "sata"},
			{Name: "sdb", Size: 30765219840, Tran: "usb"},
		},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("collect:\n got %+v\nwant %+v", got, want)
	}
}

func TestCollectTakesTheAgentID(t *testing.T) {
	if got := collect(fakeSys(t), "AA:BB:CC:00:00:01").MAC; got != "aa:bb:cc:00:00:01" {
		t.Fatalf("mac = %q, want the agent ID entry.sh passed, lowercased", got)
	}
}

func TestBootMACWithoutCarrierIsTheFirstPhysicalNIC(t *testing.T) {
	sys := fakeSys(t)
	if err := os.Remove(filepath.Join(sys, "devices/pci0000:00/0000:00:1f.6/net/enp3s0/carrier")); err != nil {
		t.Fatal(err)
	}
	if got := bootMAC(sys); got != "aa:bb:cc:00:00:01" {
		t.Fatalf("bootMAC = %q, want eno1's, not docker0's", got)
	}
}

func TestEmptyMachinePostsAnEmptyDiskList(t *testing.T) {
	body, err := json.Marshal(collect(t.TempDir(), ""))
	if err != nil {
		t.Fatal(err)
	}
	want := `{"mac":"","serial":"","uuid":"","model":"","sku":"","bios":"","disks":[]}`
	if string(body) != want {
		t.Fatalf("body = %s, want %s", body, want)
	}
}

func TestIntakeURL(t *testing.T) {
	for _, tc := range []struct {
		env, cmdline, want string
		on                 bool
	}{
		{"", "console=tty0 tink_worker_image=x", defaultURL, true},
		{"", "console=tty0 fleet_intake_url=https://example.test/fleet/intake iommu=pt", "https://example.test/fleet/intake", true},
		{"", "fleet_intake_url= console=tty0", "", false},
		{"http://127.0.0.1:1/intake", "fleet_intake_url=https://example.test/x", "http://127.0.0.1:1/intake", true},
	} {
		got, on := intakeURL(tc.env, tc.cmdline)
		if got != tc.want || on != tc.on {
			t.Errorf("intakeURL(%q, %q) = %q, %v; want %q, %v", tc.env, tc.cmdline, got, on, tc.want, tc.on)
		}
	}
}

const secret = "SECRET-RESPONSE-BODY"

// server answers each POST with the next status, the last one repeated, and a body the log must
// never carry.
func server(t *testing.T, statuses ...int) (*httptest.Server, *atomic.Int32, chan []byte) {
	t.Helper()
	var calls atomic.Int32
	bodies := make(chan []byte, 16)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := int(calls.Add(1)) - 1
		if r.Method != http.MethodPost || r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("request %s with Content-Type %q, want a JSON POST", r.Method, r.Header.Get("Content-Type"))
		}
		b, _ := io.ReadAll(r.Body)
		bodies <- b
		w.WriteHeader(statuses[min(n, len(statuses)-1)])
		_, _ = io.WriteString(w, secret)
	}))
	t.Cleanup(srv.Close)
	return srv, &calls, bodies
}

func testPoster(log io.Writer) poster {
	return newPoster(time.Second, time.Millisecond, log)
}

func TestSendNeverFollowsARedirect(t *testing.T) {
	for _, code := range []int{http.StatusFound, http.StatusTemporaryRedirect, http.StatusPermanentRedirect} {
		elsewhere, elsewhereCalls, _ := server(t, http.StatusCreated)
		var calls atomic.Int32
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			http.Redirect(w, r, elsewhere.URL, code)
		}))
		t.Cleanup(srv.Close)
		var log bytes.Buffer
		if testPoster(&log).send(srv.URL, []byte("{}")) {
			t.Errorf("send reported success on a %d", code)
		}
		if calls.Load() != 1 || elsewhereCalls.Load() != 0 {
			t.Errorf("on a %d: %d requests, %d to the redirect target; want 1 and 0", code, calls.Load(), elsewhereCalls.Load())
		}
		if !strings.Contains(log.String(), "HTTP "+strconv.Itoa(code)) {
			t.Errorf("log lacks the %d:\n%s", code, log.String())
		}
	}
}

func TestSendRefusesAURLThatMakesNoRequest(t *testing.T) {
	for _, url := range []string{"ftp://enroll.example.test/fleet/intake", "enroll.example.test/fleet/intake", "http://[::1"} {
		var log bytes.Buffer
		if testPoster(&log).send(url, []byte("{}")) {
			t.Errorf("send(%q) reported success", url)
		}
		if strings.Contains(log.String(), "attempt") {
			t.Errorf("send(%q) made an attempt:\n%s", url, log.String())
		}
	}
}

func TestSendRetriesAServerErrorAndLogsOnlyStatuses(t *testing.T) {
	srv, calls, bodies := server(t, http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusCreated)
	facts := collect(fakeSys(t), "")
	body, _ := json.Marshal(facts)
	var log bytes.Buffer
	if !testPoster(&log).send(srv.URL, body) {
		t.Fatalf("send reported failure on a 201; log:\n%s", log.String())
	}
	if calls.Load() != 3 {
		t.Fatalf("%d requests, want 3", calls.Load())
	}
	var posted Facts
	if err := json.Unmarshal(<-bodies, &posted); err != nil || !reflect.DeepEqual(posted, facts) {
		t.Fatalf("posted %+v (%v), want %+v", posted, err, facts)
	}
	for _, line := range []string{"attempt 1: HTTP 502", "attempt 2: HTTP 503", "attempt 3: HTTP 201"} {
		if !strings.Contains(log.String(), line) {
			t.Errorf("log lacks %q:\n%s", line, log.String())
		}
	}
	if strings.Contains(log.String(), secret) || strings.Contains(log.String(), facts.Serial) {
		t.Errorf("log carries a body:\n%s", log.String())
	}
}

func TestSendStopsOnAClientError(t *testing.T) {
	srv, calls, _ := server(t, http.StatusTooManyRequests)
	var log bytes.Buffer
	if testPoster(&log).send(srv.URL, []byte("{}")) {
		t.Fatal("send reported success on a 429")
	}
	if calls.Load() != 1 {
		t.Fatalf("%d requests on a 429, want 1", calls.Load())
	}
}

func TestSendGivesUpAfterFiveRetries(t *testing.T) {
	srv, calls, _ := server(t, http.StatusBadGateway)
	var log bytes.Buffer
	if testPoster(&log).send(srv.URL, []byte("{}")) {
		t.Fatal("send reported success on a 502")
	}
	if calls.Load() != 1+retries {
		t.Fatalf("%d requests, want %d", calls.Load(), 1+retries)
	}
}

func TestSendRetriesAnUnreachableServer(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL
	srv.Close()
	var log bytes.Buffer
	if testPoster(&log).send(url, []byte("{}")) {
		t.Fatal("send reported success with no server")
	}
	if got := strings.Count(log.String(), "fleet-intake: attempt"); got != 1+retries {
		t.Fatalf("%d attempts logged, want %d:\n%s", got, 1+retries, log.String())
	}
}
