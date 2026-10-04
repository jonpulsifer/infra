package main

import (
	"encoding/json"
	"math"
	"net/http"
	"time"
)

// Snapshot's json tags are the /api/cook contract. A temperature is null if
// unplugged or unread, a setting or event time until reported, a label "" until named.
type Snapshot struct {
	GeneratedAt    string           `json:"generated_at"`
	CloudConnected bool             `json:"cloud_connected"`
	Devices        []DeviceSnapshot `json:"devices"`
}

type DeviceSnapshot struct {
	ID     int           `json:"id"`
	Online bool          `json:"online"`
	Cook   *CookSnapshot `json:"cook"`
}

type CookSnapshot struct {
	ID                   int              `json:"id"`
	Active               bool             `json:"active"`
	ElapsedSeconds       int              `json:"elapsed_seconds"`
	QuietSeconds         int              `json:"quiet_seconds"`
	PitF                 *float64         `json:"pit_f"`
	SetF                 float64          `json:"set_f"`
	ReachedSet           bool             `json:"reached_set"`
	BlowerPct            float64          `json:"blower_pct"`
	LidOpen              bool             `json:"lid_open"`
	PitAlarmSecondsAgo   *int             `json:"pit_alarm_seconds_ago"`
	VentAdviceSecondsAgo *int             `json:"vent_advice_seconds_ago"`
	Probes               [3]ProbeSnapshot `json:"probes"`
	History              HistorySnapshot  `json:"history"`
}

type ProbeSnapshot struct {
	Probe          int      `json:"probe"`
	Label          string   `json:"label"`
	TempF          *float64 `json:"temp_f"`
	AlarmEnabled   *bool    `json:"alarm_enabled"`
	AlarmTriggered bool     `json:"alarm_triggered"`
}

type HistorySnapshot struct {
	StepSeconds int           `json:"step_seconds"`
	PitF        []*float64    `json:"pit_f"`
	SetF        []*float64    `json:"set_f"`
	ProbesF     [3][]*float64 `json:"probes_f"`
}

func tenthsF(deci int) float64 {
	return math.Round(fahrenheit(deci)*10) / 10
}

// tempF is nil for the unplugged sentinel.
func tempF(deci int) *float64 {
	if deci == probeUnplugged {
		return nil
	}
	f := tenthsF(deci)
	return &f
}

func wholeSeconds(d time.Duration) int {
	return int(max(d, 0) / time.Second)
}

func secondsAgo(at, now time.Time) *int {
	if at.IsZero() {
		return nil
	}
	n := wholeSeconds(now.Sub(at))
	return &n
}

// Snapshot reads every device as of now. A cook that Collect would retire is
// absent here too.
func (s *State) Snapshot() Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()

	out := Snapshot{
		GeneratedAt: now.UTC().Format(time.RFC3339),
		Devices:     make([]DeviceSnapshot, 0, len(s.devices)),
	}
	for _, up := range s.servers {
		out.CloudConnected = out.CloudConnected || up
	}
	for _, id := range sortedKeys(s.devices) {
		d := s.devices[id]
		dev := DeviceSnapshot{ID: d.id, Online: d.online}
		if c := s.liveCook(d, now); c != nil {
			cs := s.cookSnapshot(d, c, now)
			dev.Cook = &cs
		}
		out.Devices = append(out.Devices, dev)
	}
	return out
}

func (s *State) cookSnapshot(d *device, c *cook, now time.Time) CookSnapshot {
	elapsed := now.Sub(c.startedAt)
	cs := CookSnapshot{
		ID:                   c.cookID,
		Active:               s.active(c, now),
		ElapsedSeconds:       wholeSeconds(elapsed),
		QuietSeconds:         wholeSeconds(now.Sub(c.receivedAt)),
		SetF:                 tenthsF(c.setDeci),
		ReachedSet:           c.reachedSet,
		BlowerPct:            float64(c.blower) / 100,
		LidOpen:              c.lidOpen,
		PitAlarmSecondsAgo:   secondsAgo(c.pitAlarmAt, now),
		VentAdviceSecondsAgo: secondsAgo(c.ventAdviceAt, now),
		History:              historySnapshot(c.history.at(elapsed)),
	}
	if c.pitPlugged {
		cs.PitF = tempF(c.pitDeci)
	}
	for i := range cs.Probes {
		cs.Probes[i] = ProbeSnapshot{
			Probe:          i + 1,
			Label:          d.labels[i],
			TempF:          tempF(c.probesDeci[i]),
			AlarmTriggered: c.meatTriggered[i],
		}
		if on := d.meatAlarm[i]; on != nil {
			enabled := *on
			cs.Probes[i].AlarmEnabled = &enabled
		}
	}
	return cs
}

func historySnapshot(h history) HistorySnapshot {
	series := func(i int) []*float64 {
		out := make([]*float64, len(h.buckets))
		for n, b := range h.buckets {
			out[n] = tempF(b[i])
		}
		return out
	}
	hs := HistorySnapshot{
		StepSeconds: int(h.step / time.Second),
		PitF:        series(pitSeries),
		SetF:        series(setSeries),
	}
	for i := range hs.ProbesF {
		hs.ProbesF[i] = series(probeSeries + i)
	}
	return hs
}

// cookHandler serves the snapshot. It computes the document per request, so
// nothing between the exporter and the display may cache it.
func cookHandler(s *State) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(s.Snapshot())
	})
}
