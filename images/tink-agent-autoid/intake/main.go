// fleet-intake tells fleet-controller that a machine booted HookOS, before tink-agent waits for
// work. It posts the machine's DMI facts, its boot NIC's MAC, its disks and the switch port the
// switch's LLDP frame names to the intake URL, logs each answer's HTTP status and never a body, and
// exits. It listens for LLDP for at most 35 seconds while it reads the rest. entry.sh starts tink-agent whatever the
// outcome. The tink-agent image has no shell, curl or lsblk, so this is a static binary.
//
// usage: fleet-intake [boot NIC MAC]
//
// The URL is $FLEET_INTAKE_URL, else the kernel command line's fleet_intake_url=, else the
// default below. An empty fleet_intake_url= turns the post off.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	defaultURL = "https://enroll.lolwtf.ca/fleet/intake"
	retries    = 5
	timeout    = 10 * time.Second
)

type Disk struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
	Tran string `json:"tran"`
}

type Facts struct {
	MAC    string `json:"mac"`
	Serial string `json:"serial"`
	UUID   string `json:"uuid"`
	Model  string `json:"model"`
	SKU    string `json:"sku"`
	BIOS   string `json:"bios"`
	Disks  []Disk `json:"disks"`
	LLDP   *LLDP  `json:"lldp,omitempty"`
}

func main() {
	mac := ""
	if len(os.Args) > 1 {
		mac = os.Args[1]
	}
	cmdline, _ := os.ReadFile("/proc/cmdline")
	url, on := intakeURL(os.Getenv("FLEET_INTAKE_URL"), string(cmdline))
	if !on {
		fmt.Fprintln(os.Stderr, "fleet-intake: fleet_intake_url is empty, nothing posted")
		return
	}
	if mac == "" {
		mac = bootMAC("/sys")
	}
	lldp := make(chan *LLDP, 1)
	go func() { lldp <- neighbour("/sys", mac, lldpWait, os.Stderr) }()
	facts := collect("/sys", mac)
	facts.LLDP = <-lldp
	body, err := json.Marshal(facts)
	if err != nil {
		fmt.Fprintf(os.Stderr, "fleet-intake: %v\n", err)
		os.Exit(1)
	}
	fmt.Fprintf(os.Stderr, "fleet-intake: posting %s's facts to %s\n", facts.MAC, url)
	if !newPoster(timeout, time.Second, os.Stderr).send(url, body) {
		os.Exit(1)
	}
}

func intakeURL(env, cmdline string) (string, bool) {
	if env != "" {
		return env, true
	}
	for _, field := range strings.Fields(cmdline) {
		if v, ok := strings.CutPrefix(field, "fleet_intake_url="); ok {
			return v, v != ""
		}
	}
	return defaultURL, true
}

// collect reads the facts under a sysfs root. A given MAC is the agent ID entry.sh chose, so the
// controller's Hardware matches the agent that asks it for work.
func collect(sys, mac string) Facts {
	dmi := func(name string) string { return read(filepath.Join(sys, "class/dmi/id", name)) }
	if mac == "" {
		mac = bootMAC(sys)
	}
	return Facts{
		MAC:    strings.ToLower(mac),
		Serial: dmi("product_serial"),
		UUID:   strings.ToLower(dmi("product_uuid")),
		Model:  dmi("product_name"),
		SKU:    dmi("product_sku"),
		BIOS:   dmi("bios_version"),
		Disks:  disks(sys),
	}
}

// bootMAC is the MAC of the physical NIC with carrier, else of the first physical NIC, else of the
// first other one that is not loopback. Docker's bridge and other virtual links have no device.
func bootMAC(sys string) string {
	entries, _ := os.ReadDir(filepath.Join(sys, "class/net"))
	var physical, virtual []string
	for _, e := range entries {
		dir := filepath.Join(sys, "class/net", e.Name())
		mac := read(filepath.Join(dir, "address"))
		if e.Name() == "lo" || mac == "" || mac == "00:00:00:00:00:00" {
			continue
		}
		if !exists(filepath.Join(dir, "device")) {
			virtual = append(virtual, mac)
			continue
		}
		if read(filepath.Join(dir, "carrier")) == "1" {
			return mac
		}
		physical = append(physical, mac)
	}
	for _, macs := range [][]string{physical, virtual} {
		if len(macs) > 0 {
			return macs[0]
		}
	}
	return ""
}

// disks lists what `lsblk -d` would of the block devices backed by hardware, with the size in
// bytes. Loop, RAM and device-mapper devices have no device link, and an empty drive no size.
func disks(sys string) []Disk {
	out := []Disk{}
	root, _ := filepath.EvalSymlinks(sys)
	entries, _ := os.ReadDir(filepath.Join(sys, "block"))
	for _, e := range entries {
		dir := filepath.Join(sys, "block", e.Name())
		if !exists(filepath.Join(dir, "device")) {
			continue
		}
		sectors, err := strconv.ParseInt(read(filepath.Join(dir, "size")), 10, 64)
		if err != nil || sectors == 0 {
			continue
		}
		path, _ := filepath.EvalSymlinks(dir)
		out = append(out, Disk{
			Name: e.Name(),
			Size: sectors * 512,
			Tran: transport(e.Name(), strings.TrimPrefix(path, root)),
		})
	}
	return out
}

// transport names the bus as lsblk's TRAN column does, from the device's sysfs path.
func transport(name, path string) string {
	switch {
	case strings.HasPrefix(name, "nvme"):
		return "nvme"
	case strings.Contains(path, "/usb"):
		return "usb"
	case strings.Contains(path, "/ata"):
		return "sata"
	case strings.Contains(path, "/virtio"):
		return "virtio"
	case strings.HasPrefix(name, "mmcblk"):
		return "mmc"
	}
	return ""
}

type poster struct {
	client  *http.Client
	backoff time.Duration
	log     io.Writer
}

// newPoster follows no redirect, so a 307 or 308 never sends the facts to another host or over
// plain HTTP; the 3xx is the answer.
func newPoster(timeout, backoff time.Duration, log io.Writer) poster {
	client := &http.Client{
		Timeout: timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	return poster{client: client, backoff: backoff, log: log}
}

// send posts once and retries a transport error or a 5xx, doubling the wait each time. Any other
// answer is final: a 3xx is never followed, and a 4xx says the controller will not take this
// machine now. A URL that cannot make a request is final before the first attempt.
func (p poster) send(url string, body []byte) bool {
	if _, err := request(url, body); err != nil {
		fmt.Fprintf(p.log, "fleet-intake: %v\n", err)
		return false
	}
	wait := p.backoff
	for attempt := 1; ; attempt++ {
		status, err := p.post(url, body)
		if err != nil {
			fmt.Fprintf(p.log, "fleet-intake: attempt %d: %v\n", attempt, err)
		} else {
			fmt.Fprintf(p.log, "fleet-intake: attempt %d: HTTP %d\n", attempt, status)
			if status < 500 {
				return status >= 200 && status < 300
			}
		}
		if attempt > retries {
			return false
		}
		time.Sleep(wait)
		wait *= 2
	}
}

func request(rawURL string, body []byte) (*http.Request, error) {
	req, err := http.NewRequest(http.MethodPost, rawURL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	if (req.URL.Scheme != "http" && req.URL.Scheme != "https") || req.URL.Host == "" {
		return nil, fmt.Errorf("%q is not an http or https URL", rawURL)
	}
	req.Header.Set("Content-Type", "application/json")
	return req, nil
}

func (p poster) post(url string, body []byte) (int, error) {
	req, err := request(url, body)
	if err != nil {
		return 0, err
	}
	resp, err := p.client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	return resp.StatusCode, nil
}

func read(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
