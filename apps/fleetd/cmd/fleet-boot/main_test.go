package main

import (
	"context"
	"encoding/binary"
	"errors"
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

func TestDefaultRouteInterface(t *testing.T) {
	table := `Iface	Destination	Gateway 	Flags	RefCnt	Use	Metric	Mask		MTU	Window	IRTT
enp1s0	0000090A	00000000	0001	0	0	0	00FFFFFF	0	0	0
enp2s0	00000000	0100090A	0002	0	0	0	00000000	0	0	0
enp1s0	00000000	0100090A	0003	0	0	1024	00000000	0	0	0
`
	if got := defaultRouteInterface(strings.NewReader(table)); got != "enp1s0" {
		t.Errorf("got %q, want enp1s0: a default route that is not up does not count", got)
	}
	if got := defaultRouteInterface(strings.NewReader("Iface\tDestination\n")); got != "" {
		t.Errorf("got %q from a table with no default route", got)
	}
}

func ntpPacket(mode, stratum byte, receive, transmit time.Time) []byte {
	b := make([]byte, 48)
	b[0] = 0x20 | mode
	b[1] = stratum
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
	got, err := sntpOffset(ntpPacket(4, 2, server, server), t1, t4)
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
		if _, err := sntpOffset(p, t1, t4); err == nil {
			t.Errorf("%s: no error", name)
		}
	}
	unsynced := ntpPacket(4, 2, server, server)
	unsynced[0] |= 0xc0
	if _, err := sntpOffset(unsynced, t1, t4); err == nil {
		t.Error("an unsynchronized server set the clock")
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
