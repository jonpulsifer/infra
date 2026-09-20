package main

import (
	"math"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// probeUnplugged is what the controller reports for a probe that is not
// connected. It is a sentinel, not a temperature: converted it reads as
// -5866 F, which would drag every graph's y-axis to the floor and make an
// unplugged probe look like a cook in a freezer.
const probeUnplugged = -32767

// fahrenheit converts the wire scale -- decidegrees Celsius on every
// temperature field of every message -- to the scale the cook is read in.
// Rounded to the hundredth: the controller reports a tenth of a degree
// Celsius, so the digits past that are float noise, and they would otherwise
// be exposed as `267.08000000000004`.
func fahrenheit(deci int) float64 {
	return math.Round((float64(deci)*9/50+32)*100) / 100
}

// pitAtTarget is how close the pit has to come to the set temperature, in F,
// before the cook counts as settled. Until it does, the pit is legitimately
// far below set and the band alerts have nothing to say.
const pitAtTarget = 5

// cook is the telemetry of one cook on one device. Its zero value is not a
// cook: cookID 0 means no temps message has arrived yet.
type cook struct {
	cookID     int
	startedAt  time.Time // first telemetry seen for this cookID
	dataAt     time.Time // device's own timestamp on the last telemetry
	receivedAt time.Time // when this process last heard from the device
	pitDeci    int
	setDeci    int
	probesDeci [3]int
	blower     int // 0-10000
	reachedSet bool
	pitPlugged bool
}

type device struct {
	id     int
	server string
	online bool
	cook   *cook
	// Counters are per message name so an uplink this exporter does not model
	// still shows up -- flameboss/<id>/send/data carries alarm and lid
	// messages that a controller only publishes when they change, and the
	// counter is how we learn they arrived at all.
	messages map[string]uint64
}

// State holds everything the collector reports. Every field is written by MQTT
// callbacks, which paho may run concurrently, and read by a scrape.
type State struct {
	mu sync.Mutex

	devices map[int]*device
	servers map[string]bool   // server FQDN -> connected
	reconn  map[string]uint64 // server FQDN -> reconnects

	// stale is how long a cook may go without telemetry and still count as
	// live; retire is when the cook's series are dropped entirely, which is
	// what resolves the silence alert instead of leaving it firing forever.
	stale  time.Duration
	retire time.Duration

	now func() time.Time
}

func NewState(stale, retire time.Duration) *State {
	return &State{
		devices: map[int]*device{},
		servers: map[string]bool{},
		reconn:  map[string]uint64{},
		stale:   stale,
		retire:  retire,
		now:     time.Now,
	}
}

func (s *State) dev(id int) *device {
	d, ok := s.devices[id]
	if !ok {
		d = &device{id: id, messages: map[string]uint64{}}
		s.devices[id] = d
	}
	return d
}

// SetBrokerConnected records a connection's state. A server this process has
// never dialed is absent rather than 0: a bare 0 for every server Flame Boss
// runs would be an alert on someone else's shard.
func (s *State) SetBrokerConnected(server string, up bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if was, seen := s.servers[server]; seen && was && !up {
		s.reconn[server]++
	}
	s.servers[server] = up
}

func (s *State) ForgetServer(server string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.servers, server)
}

// SeeDevice records what the control plane said: this device is online, on
// this server. It is the only signal that a controller exists before it
// publishes anything.
func (s *State) SeeDevice(id int, server string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.dev(id)
	d.server = server
	d.online = true
}

func (s *State) SetDeviceOnline(id int, online bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.dev(id).online = online
}

func (s *State) CountMessage(id int, name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.dev(id).messages[name]++
}

// Temps applies a temps uplink. A new cookID starts a new cook: the settled
// flag and the start time belong to one cook and must not carry over.
func (s *State) Temps(id int, m Temps) {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.dev(id)
	now := s.now()

	if d.cook == nil || d.cook.cookID != m.CookID {
		d.cook = &cook{cookID: m.CookID, startedAt: now}
	}
	c := d.cook
	c.receivedAt = now
	c.dataAt = time.Unix(int64(m.Sec), 0)
	c.setDeci = m.SetTemp
	c.blower = m.Blower

	if len(m.Temps) > 0 {
		c.pitDeci = m.Temps[0]
		c.pitPlugged = m.Temps[0] != probeUnplugged
	}
	for i := range c.probesDeci {
		if i+1 < len(m.Temps) {
			c.probesDeci[i] = m.Temps[i+1]
		} else {
			c.probesDeci[i] = probeUnplugged
		}
	}

	if c.pitPlugged && fahrenheit(c.pitDeci) >= fahrenheit(c.setDeci)-pitAtTarget {
		c.reachedSet = true
	}
}

// Descriptors. Temperatures are Fahrenheit because that is the scale the cook
// is read in; the decidegree Celsius the wire carries appears nowhere outside
// fahrenheit().
var (
	descBroker = prometheus.NewDesc("flameboss_broker_connected",
		"1 when this exporter holds an MQTT connection to the named Flame Boss server.",
		[]string{"server"}, nil)
	descReconnects = prometheus.NewDesc("flameboss_broker_reconnects_total",
		"Times a connection to the named Flame Boss server was lost.",
		[]string{"server"}, nil)
	descOnline = prometheus.NewDesc("flameboss_device_online",
		"1 when the Flame Boss control plane reports the controller as connected.",
		[]string{"device"}, nil)
	descServer = prometheus.NewDesc("flameboss_device_server",
		"1, labelled with the Flame Boss server the controller is currently on.",
		[]string{"device", "server"}, nil)
	descMessages = prometheus.NewDesc("flameboss_messages_total",
		"Uplink messages received, by message name.",
		[]string{"device", "name"}, nil)
	descCook = prometheus.NewDesc("flameboss_cook",
		"1, labelled with the id of the cook the controller is currently logging.",
		[]string{"device", "cook_id"}, nil)
	descCookActive = prometheus.NewDesc("flameboss_cook_active",
		"1 while cook telemetry is arriving, 0 once it has gone quiet.",
		[]string{"device"}, nil)
	descCookStart = prometheus.NewDesc("flameboss_cook_start_timestamp_seconds",
		"When this exporter first saw telemetry for the current cook.",
		[]string{"device"}, nil)
	descDataAt = prometheus.NewDesc("flameboss_telemetry_timestamp_seconds",
		"The controller's own timestamp on its last reading.",
		[]string{"device"}, nil)
	descPit = prometheus.NewDesc("flameboss_pit_temp_fahrenheit",
		"Pit temperature.",
		[]string{"device"}, nil)
	descPitPlugged = prometheus.NewDesc("flameboss_pit_probe_connected",
		"1 when the pit probe is plugged in.",
		[]string{"device"}, nil)
	descTarget = prometheus.NewDesc("flameboss_pit_target_fahrenheit",
		"Set temperature the controller is holding the pit to.",
		[]string{"device"}, nil)
	descReached = prometheus.NewDesc("flameboss_pit_reached_target",
		"1 once the pit has come within 5F of set at least once during this cook.",
		[]string{"device"}, nil)
	descProbe = prometheus.NewDesc("flameboss_probe_temp_fahrenheit",
		"Meat probe temperature. An unplugged probe reports no series.",
		[]string{"device", "probe"}, nil)
	descBlower = prometheus.NewDesc("flameboss_blower_percent",
		"Blower duty cycle.",
		[]string{"device"}, nil)
)

func (s *State) Describe(ch chan<- *prometheus.Desc) {
	for _, d := range []*prometheus.Desc{
		descBroker, descReconnects, descOnline, descServer, descMessages,
		descCook, descCookActive, descCookStart, descDataAt, descPit,
		descPitPlugged, descTarget, descReached, descProbe, descBlower,
	} {
		ch <- d
	}
}

func (s *State) Collect(ch chan<- prometheus.Metric) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()

	gauge := func(d *prometheus.Desc, v float64, labels ...string) {
		ch <- prometheus.MustNewConstMetric(d, prometheus.GaugeValue, v, labels...)
	}

	for _, server := range sortedKeys(s.servers) {
		gauge(descBroker, boolValue(s.servers[server]), server)
	}
	for _, server := range sortedKeys(s.reconn) {
		ch <- prometheus.MustNewConstMetric(descReconnects, prometheus.CounterValue,
			float64(s.reconn[server]), server)
	}

	for _, id := range sortedKeys(s.devices) {
		d := s.devices[id]
		dev := strconv.Itoa(d.id)

		gauge(descOnline, boolValue(d.online), dev)
		if d.server != "" {
			gauge(descServer, 1, dev, d.server)
		}
		for _, name := range sortedKeys(d.messages) {
			ch <- prometheus.MustNewConstMetric(descMessages, prometheus.CounterValue,
				float64(d.messages[name]), dev, name)
		}

		c := d.cook
		if c == nil {
			continue
		}
		// A cook that has been quiet past the retire window is over. Dropping
		// its series is what resolves the silence alert; keeping them at their
		// last value would leave a cold pit graphed as a live cook forever.
		if now.Sub(c.receivedAt) > s.retire {
			d.cook = nil
			continue
		}

		gauge(descCook, 1, dev, strconv.Itoa(c.cookID))
		gauge(descCookActive, boolValue(now.Sub(c.receivedAt) <= s.stale), dev)
		gauge(descCookStart, float64(c.startedAt.Unix()), dev)
		gauge(descDataAt, float64(c.dataAt.Unix()), dev)
		gauge(descTarget, fahrenheit(c.setDeci), dev)
		gauge(descReached, boolValue(c.reachedSet), dev)
		gauge(descBlower, float64(c.blower)/100, dev)
		gauge(descPitPlugged, boolValue(c.pitPlugged), dev)
		if c.pitPlugged {
			gauge(descPit, fahrenheit(c.pitDeci), dev)
		}
		for i, deci := range c.probesDeci {
			if deci == probeUnplugged {
				continue
			}
			gauge(descProbe, fahrenheit(deci), dev, strconv.Itoa(i+1))
		}
	}
}

func boolValue(b bool) float64 {
	if b {
		return 1
	}
	return 0
}

type ordered interface{ ~int | ~string }

func sortedKeys[K ordered, V any](m map[K]V) []K {
	keys := make([]K, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i] < keys[j] })
	return keys
}
