package main

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"log/syslog"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jonpulsifer/infra/apps/fleetd/client"
	"github.com/jonpulsifer/infra/apps/fleetd/protocol"
)

func TestCmdlineValue(t *testing.T) {
	line := "console=ttyS0,115200 syslog_host=10.0.0.2 fleet_attest_url=https://enroll.example/attest fleet_ntp_server=10.0.0.2"
	for key, want := range map[string]string{
		"fleet_attest_url": "https://enroll.example/attest",
		"syslog_host":      "10.0.0.2",
		"console":          "ttyS0,115200",
		"fleet":            "",
		"missing":          "",
	} {
		if got := cmdlineValue(line, key); got != want {
			t.Errorf("cmdlineValue(%q) = %q, want %q", key, got, want)
		}
	}
}

func TestDefaultRouteInterfaces(t *testing.T) {
	table := `Iface	Destination	Gateway 	Flags	RefCnt	Use	Metric	Mask		MTU	Window	IRTT
enp1s0	0000090A	00000000	0001	0	0	0	00FFFFFF	0	0	0
enp2s0	00000000	0100090A	0002	0	0	0	00000000	0	0	0
enp1s0	00000000	0100090A	0003	0	0	1024	00000000	0	0	0
enp3s0	00000000	0100090A	0003	0	0	1025	00000000	0	0	0
`
	if got := defaultRouteInterfaces(strings.NewReader(table)); len(got) != 2 || got[0] != "enp1s0" || got[1] != "enp3s0" {
		t.Errorf("got %q, want enp1s0 and enp3s0: a default route that is not up does not count", got)
	}
	if got := defaultRouteInterfaces(strings.NewReader("Iface\tDestination\n")); len(got) != 0 {
		t.Errorf("got %q from a table with no default route", got)
	}
}

// origin is the transmit timestamp the tests' requests carry, which an
// answer echoes.
var origin = []byte("fleet-tx")

func ntpPacket(mode, stratum byte, receive, transmit time.Time) []byte {
	b := make([]byte, 48)
	b[0] = 0x20 | mode
	b[1] = stratum
	copy(b[24:32], origin)
	put := func(off int, at time.Time) {
		d := at.Sub(ntpEpoch)
		binary.BigEndian.PutUint32(b[off:], uint32(d/time.Second))
		binary.BigEndian.PutUint32(b[off+4:], uint32((uint64(d%time.Second)<<32)/uint64(time.Second)))
	}
	put(32, receive)
	put(40, transmit)
	return b
}

func TestSNTPOffset(t *testing.T) {
	t1 := time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)
	t4 := t1.Add(20 * time.Millisecond)
	// The server is an hour ahead, and the request and answer took 10 ms each.
	server := t1.Add(time.Hour + 10*time.Millisecond)
	got, err := sntpOffset(ntpPacket(4, 2, server, server), origin, t1, t4)
	if err != nil {
		t.Fatal(err)
	}
	if d := got - time.Hour; d < -time.Millisecond || d > time.Millisecond {
		t.Errorf("offset %s, want 1h", got)
	}
	for name, p := range map[string][]byte{
		"client mode": ntpPacket(3, 2, server, server),
		"stratum 0":   ntpPacket(4, 0, server, server),
		"short":       make([]byte, 12),
	} {
		if _, err := sntpOffset(p, origin, t1, t4); err == nil {
			t.Errorf("%s: no error", name)
		}
	}
	unsynced := ntpPacket(4, 2, server, server)
	unsynced[0] |= 0xc0
	if _, err := sntpOffset(unsynced, origin, t1, t4); err == nil {
		t.Error("an unsynchronized server set the clock")
	}
	// An answer to another request, or a forged one, does not echo the
	// request's random transmit timestamp.
	if _, err := sntpOffset(ntpPacket(4, 2, server, server), []byte("otherreq"), t1, t4); err == nil {
		t.Error("an answer that does not echo the request set the clock")
	}
	// No answer turns the clock back before fleet-boot's build.
	past := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	if _, err := sntpOffset(ntpPacket(4, 2, past, past), origin, t1, t4); err == nil {
		t.Error("an answer set the clock before the floor")
	}
}

// A verdict stops the tries at once; an outage is tried again.
func TestAttestStopsOnAVerdict(t *testing.T) {
	calls := 0
	_, err := attest(context.Background(), 5, 0, t.Logf, func(context.Context) (*client.Result, error) {
		calls++
		return nil, &client.RefusedError{Status: http.StatusForbidden}
	})
	if err == nil || calls != 1 {
		t.Errorf("calls %d, err %v; want one call and an error", calls, err)
	}
	calls = 0
	res, err := attest(context.Background(), 5, 0, t.Logf, func(context.Context) (*client.Result, error) {
		calls++
		if calls < 3 {
			return nil, &client.RefusedError{Status: http.StatusServiceUnavailable}
		}
		return &client.Result{}, nil
	})
	if err != nil || res == nil || calls != 3 {
		t.Errorf("calls %d, err %v; want a pass on the third try", calls, err)
	}
	calls = 0
	if _, err := attest(context.Background(), 2, 0, t.Logf, func(context.Context) (*client.Result, error) {
		calls++
		return nil, errors.New("dial tcp: connection refused")
	}); err == nil || calls != 2 {
		t.Errorf("calls %d, err %v; want two calls and an error", calls, err)
	}
}

type fakeRun struct {
	errs []error
	run  protocol.BootRun
	n    int
}

func (f *fakeRun) Run(context.Context) (protocol.BootRun, error) {
	f.n++
	if len(f.errs) > 0 {
		err := f.errs[0]
		f.errs = f.errs[1:]
		return protocol.BootRun{}, err
	}
	return f.run, nil
}

// A fleetd that serves no boot route answers no run, and the machine waits;
// an outage is tried again.
func TestAskRun(t *testing.T) {
	f := &fakeRun{errs: []error{client.ErrNoBoot}, run: protocol.BootRun{Run: "x"}}
	r, err := askRun(context.Background(), f, 3, 0, t.Logf)
	if err != nil || r.Run != "" || f.n != 1 {
		t.Errorf("run %+v err %v calls %d; want no run after one call", r, err, f.n)
	}
	f = &fakeRun{errs: []error{errors.New("timeout")}, run: protocol.BootRun{Run: "provision-x"}}
	r, err = askRun(context.Background(), f, 3, 0, t.Logf)
	if err != nil || r.Run != "provision-x" {
		t.Errorf("run %+v err %v; want the run on the second try", r, err)
	}
	f = &fakeRun{errs: []error{errors.New("a"), errors.New("b")}}
	if _, err = askRun(context.Background(), f, 2, 0, t.Logf); err == nil {
		t.Error("two failures gave no error")
	}
}

// loadOption builds a Boot#### variable as efivarfs gives it: attributes,
// then an EFI_LOAD_OPTION whose device path is the nodes given.
func loadOption(desc string, nodes ...[]byte) []byte {
	var path []byte
	for _, n := range nodes {
		path = append(path, n...)
	}
	path = append(path, 0x7f, 0xff, 4, 0)
	b := []byte{7, 0, 0, 0, 1, 0, 0, 0, byte(len(path)), byte(len(path) >> 8)}
	for _, r := range desc {
		b = append(b, byte(r), 0)
	}
	b = append(b, 0, 0)
	return append(b, path...)
}

func macNode(mac []byte) []byte {
	n := []byte{3, 11, 37, 0}
	addr := make([]byte, 32)
	copy(addr, mac)
	return append(append(n, addr...), 1)
}

// The firmware's boot entry names the NIC that netbooted.
func TestLoadOptionMAC(t *testing.T) {
	pci := []byte{1, 1, 6, 0, 6, 0x1f}
	v := loadOption("UEFI: IPV4 Intel(R) Ethernet", pci, macNode([]byte{0x38, 0x22, 0xe2, 0x2d, 0x96, 0x44}), []byte{3, 12, 27, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0})
	if got, ok := loadOptionMAC(v); !ok || got != "38:22:e2:2d:96:44" {
		t.Errorf("got %q %v", got, ok)
	}
	if _, ok := loadOptionMAC(loadOption("Talos Linux UKI", []byte{4, 1, 42, 0}, make([]byte, 38))); ok {
		t.Error("a disk entry named a MAC")
	}
	if _, ok := loadOptionMAC(v[:20]); ok {
		t.Error("a short variable named a MAC")
	}
}

func TestCandidateMACs(t *testing.T) {
	got := candidateMACs("38:22:E2:2D:96:44", []string{"aa:bb:cc:00:00:01\n", "38:22:e2:2d:96:44\n"})
	if len(got) != 2 || got[0] != "38:22:e2:2d:96:44" || got[1] != "aa:bb:cc:00:00:01" {
		t.Errorf("got %q", got)
	}
	if got := candidateMACs("", []string{"aa:bb:cc:00:00:01"}); len(got) != 1 {
		t.Errorf("got %q without a firmware MAC", got)
	}
}

// A claim fleetd refuses for its MAC tries the next NIC; another verdict
// does not.
func TestEachMAC(t *testing.T) {
	var tried []string
	res, err := eachMAC([]string{"a", "b", "c"}, t.Logf, func(mac string) (*client.Result, error) {
		tried = append(tried, mac)
		if mac == "b" {
			return &client.Result{}, nil
		}
		return nil, fmt.Errorf("fleetd gave a verdict: %w", &client.RefusedError{Status: http.StatusBadRequest})
	})
	if err != nil || res == nil || strings.Join(tried, "") != "ab" {
		t.Errorf("tried %v err %v", tried, err)
	}
	tried = nil
	if _, err := eachMAC([]string{"a", "b"}, t.Logf, func(mac string) (*client.Result, error) {
		tried = append(tried, mac)
		return nil, &client.RefusedError{Status: http.StatusForbidden}
	}); err == nil || len(tried) != 1 {
		t.Errorf("a 403 tried %v", tried)
	}
}

// The network facts are gathered once and served to every try.
func TestOnce(t *testing.T) {
	n := 0
	f := once(func() int { n++; return n })
	if f() != 1 || f() != 1 || n != 1 {
		t.Errorf("calls %d", n)
	}
}

// The syslog receiver is dialed when a line comes, not once at start, so a
// dial before the route exists is tried again.
func TestLoggerDialsLate(t *testing.T) {
	dials := 0
	l := &logger{host: "10.0.0.2", dial: func(string) (*syslog.Writer, error) {
		dials++
		return nil, errors.New("network is unreachable")
	}}
	now := time.Unix(1_700_000_000, 0)
	l.receiver(now)
	l.receiver(now.Add(time.Second))
	l.receiver(now.Add(redial))
	if dials != 2 {
		t.Errorf("%d dials, want one per %s", dials, redial)
	}
}
