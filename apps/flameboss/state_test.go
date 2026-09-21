package main

import (
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	dto "github.com/prometheus/client_model/go"
)

// The conversion the whole exporter rests on. 1072 decidegrees Celsius is the
// number a controller set to 225F actually publishes.
func TestFahrenheit(t *testing.T) {
	for _, tc := range []struct {
		deci int
		want float64
	}{
		{1072, 224.96}, // what a controller set to 225F publishes
		{0, 32},
		{1000, 212},
		{1306, 267.08},
	} {
		if got := fahrenheit(tc.deci); got < tc.want-0.01 || got > tc.want+0.01 {
			t.Errorf("fahrenheit(%d) = %v, want %v", tc.deci, got, tc.want)
		}
	}
}

func fixedState(t *testing.T, now time.Time) *State {
	t.Helper()
	s := NewState(5*time.Minute, 30*time.Minute)
	s.now = func() time.Time { return now }
	return s
}

// An unplugged probe must produce no series at all. Reported as a temperature
// it is -5866F, which is not a reading of anything.
func TestUnpluggedProbeIsNotATemperature(t *testing.T) {
	now := time.Unix(1789943581, 0)
	s := fixedState(t, now)
	s.Temps(193415, Temps{
		Name: "temps", CookID: 5242100, Sec: 1789943581,
		Temps:   []int{1306, probeUnplugged, probeUnplugged, probeUnplugged},
		SetTemp: 1212, Blower: 0,
	})

	want := `
# HELP flameboss_pit_temp_fahrenheit Pit temperature.
# TYPE flameboss_pit_temp_fahrenheit gauge
flameboss_pit_temp_fahrenheit{device="193415"} 267.08
`
	if err := testutil.CollectAndCompare(s, strings.NewReader(want), "flameboss_pit_temp_fahrenheit", "flameboss_probe_temp_fahrenheit"); err != nil {
		t.Error(err)
	}
}

func TestPluggedProbesAreReported(t *testing.T) {
	s := fixedState(t, time.Unix(1789943581, 0))
	s.Temps(1, Temps{Name: "temps", CookID: 7, Sec: 1789943581,
		Temps: []int{1072, 749, probeUnplugged, 600}, SetTemp: 1072, Blower: 2500})

	want := `
# HELP flameboss_probe_temp_fahrenheit Meat probe temperature. An unplugged probe reports no series.
# TYPE flameboss_probe_temp_fahrenheit gauge
flameboss_probe_temp_fahrenheit{device="1",probe="1"} 166.82
flameboss_probe_temp_fahrenheit{device="1",probe="3"} 140
# HELP flameboss_blower_percent Blower duty cycle.
# TYPE flameboss_blower_percent gauge
flameboss_blower_percent{device="1"} 25
`
	if err := testutil.CollectAndCompare(s, strings.NewReader(want),
		"flameboss_probe_temp_fahrenheit", "flameboss_blower_percent"); err != nil {
		t.Error(err)
	}
}

// A short temps array must not report the probes it did not mention as a
// reading held over from the last message.
func TestShortTempsArrayClearsProbes(t *testing.T) {
	s := fixedState(t, time.Unix(100, 0))
	s.Temps(1, Temps{Name: "temps", CookID: 7, Temps: []int{1072, 749}, SetTemp: 1072})
	if got := testutil.CollectAndCount(s, "flameboss_probe_temp_fahrenheit"); got != 1 {
		t.Fatalf("probe series = %d, want 1", got)
	}
	s.Temps(1, Temps{Name: "temps", CookID: 7, Temps: []int{1072}, SetTemp: 1072})
	if got := testutil.CollectAndCount(s, "flameboss_probe_temp_fahrenheit"); got != 0 {
		t.Fatalf("probe series after a shorter message = %d, want 0", got)
	}
}

// pit_reached_target is what keeps the band alerts quiet during the ramp, so
// it has to latch for the cook and reset when a new cook starts.
func TestReachedTargetLatchesPerCook(t *testing.T) {
	s := fixedState(t, time.Unix(100, 0))
	ramp := Temps{Name: "temps", CookID: 7, Temps: []int{600}, SetTemp: 1072}
	s.Temps(1, ramp)
	if err := testutil.CollectAndCompare(s, strings.NewReader(`
# HELP flameboss_pit_reached_target 1 once the pit has come within 5F of set at least once during this cook.
# TYPE flameboss_pit_reached_target gauge
flameboss_pit_reached_target{device="1"} 0
`), "flameboss_pit_reached_target"); err != nil {
		t.Error(err)
	}

	// Within 5F of set counts as settled, and a later dip does not unlatch it:
	// a pit that has been up and fell back is exactly what the alerts are for.
	s.Temps(1, Temps{Name: "temps", CookID: 7, Temps: []int{1050}, SetTemp: 1072})
	s.Temps(1, ramp)
	if v := only(t, s, "flameboss_pit_reached_target"); v != 1 {
		t.Errorf("reached target after a dip = %v, want 1", v)
	}

	// A new cook id is a new fire.
	s.Temps(1, Temps{Name: "temps", CookID: 8, Temps: []int{600}, SetTemp: 1072})
	if v := only(t, s, "flameboss_pit_reached_target"); v != 0 {
		t.Errorf("reached target on a new cook = %v, want 0", v)
	}
}

func TestNewCookResetsStartTime(t *testing.T) {
	first := time.Unix(1000, 0)
	s := fixedState(t, first)
	s.Temps(1, Temps{Name: "temps", CookID: 7, Temps: []int{600}, SetTemp: 1072})
	s.now = func() time.Time { return first.Add(2 * time.Hour) }
	s.Temps(1, Temps{Name: "temps", CookID: 7, Temps: []int{1070}, SetTemp: 1072})
	if v := only(t, s, "flameboss_cook_start_timestamp_seconds"); v != 1000 {
		t.Errorf("start time within one cook = %v, want 1000", v)
	}
	s.Temps(1, Temps{Name: "temps", CookID: 8, Temps: []int{600}, SetTemp: 1072})
	if v := only(t, s, "flameboss_cook_start_timestamp_seconds"); v != 8200 {
		t.Errorf("start time on a new cook = %v, want 8200", v)
	}
}

// Silence has two stages, and both matter to the alerts: the cook stops being
// active, then the cook stops existing. The second is what resolves the alert.
func TestSilenceEndsTheCook(t *testing.T) {
	start := time.Unix(1000, 0)
	s := fixedState(t, start)
	s.Temps(193415, Temps{Name: "temps", CookID: 5242100, Temps: []int{1306}, SetTemp: 1212})
	s.CountMessage(193415, "temps")

	if v := only(t, s, "flameboss_cook_active"); v != 1 {
		t.Fatalf("cook_active while fresh = %v, want 1", v)
	}

	s.now = func() time.Time { return start.Add(6 * time.Minute) }
	if v := only(t, s, "flameboss_cook_active"); v != 0 {
		t.Errorf("cook_active after six quiet minutes = %v, want 0", v)
	}
	if got := testutil.CollectAndCount(s, "flameboss_pit_temp_fahrenheit"); got != 1 {
		t.Errorf("pit series during the quiet window = %d, want 1", got)
	}

	s.now = func() time.Time { return start.Add(31 * time.Minute) }
	for _, metric := range []string{"flameboss_cook", "flameboss_cook_active", "flameboss_pit_temp_fahrenheit"} {
		if got := testutil.CollectAndCount(s, metric); got != 0 {
			t.Errorf("%s after the retire window = %d, want 0", metric, got)
		}
	}
	// The device and its message counters outlive the cook: they describe the
	// controller, not the fire.
	if got := testutil.CollectAndCount(s, "flameboss_messages_total"); got != 1 {
		t.Errorf("messages_total after the retire window = %d, want 1", got)
	}
}

// A connection that drops and comes back is one reconnect. A server dialled for
// the first time is not.
func TestReconnectsCountTransitions(t *testing.T) {
	s := fixedState(t, time.Unix(1000, 0))
	s.SetBrokerConnected("s2.myflameboss.com", true)
	if got := testutil.CollectAndCount(s, "flameboss_broker_reconnects_total"); got != 0 {
		t.Fatalf("reconnects on a first connect = %d, want 0", got)
	}
	s.SetBrokerConnected("s2.myflameboss.com", false)
	s.SetBrokerConnected("s2.myflameboss.com", true)
	if v := only(t, s, "flameboss_broker_reconnects_total"); v != 1 {
		t.Errorf("reconnects = %v, want 1", v)
	}
}

func TestControlPlaneDeviceOutlivesNoTelemetry(t *testing.T) {
	s := fixedState(t, time.Unix(1000, 0))
	s.SeeDevice(193415, "s2.myflameboss.com")
	want := `
# HELP flameboss_device_online 1 when the Flame Boss control plane reports the controller as connected.
# TYPE flameboss_device_online gauge
flameboss_device_online{device="193415"} 1
# HELP flameboss_device_server 1, labelled with the Flame Boss server the controller is currently on.
# TYPE flameboss_device_server gauge
flameboss_device_server{device="193415",server="s2.myflameboss.com"} 1
`
	if err := testutil.CollectAndCompare(s, strings.NewReader(want),
		"flameboss_device_online", "flameboss_device_server"); err != nil {
		t.Error(err)
	}
	if got := testutil.CollectAndCount(s, "flameboss_cook_active"); got != 0 {
		t.Errorf("cook_active for a device that has published nothing = %d, want 0", got)
	}
}

// only reads the value of one named metric and fails unless there is exactly
// one series of it, so a test asserting a value cannot silently read the first
// of several.
func only(t *testing.T, c prometheus.Collector, name string) float64 {
	t.Helper()
	ch := make(chan prometheus.Metric, 64)
	go func() {
		c.Collect(ch)
		close(ch)
	}()
	var found []float64
	for m := range ch {
		if !strings.Contains(m.Desc().String(), `fqName: "`+name+`"`) {
			continue
		}
		var out dto.Metric
		if err := m.Write(&out); err != nil {
			t.Fatal(err)
		}
		switch {
		case out.Gauge != nil:
			found = append(found, out.Gauge.GetValue())
		case out.Counter != nil:
			found = append(found, out.Counter.GetValue())
		default:
			t.Fatalf("%s is neither a gauge nor a counter", name)
		}
	}
	if len(found) != 1 {
		t.Fatalf("%s: %d series, want 1", name, len(found))
	}
	return found[0]
}
