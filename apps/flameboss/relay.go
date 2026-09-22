package main

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"log/slog"
	"math/rand"
	"strconv"
	"strings"
	"sync"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
)

// Temps is the one uplink this exporter reads for cook telemetry. Every
// temperature in it is decidegrees Celsius regardless of what the controller's
// own display is set to.
type Temps struct {
	Name    string `json:"name"`
	CookID  int    `json:"cook_id"`
	Sec     int    `json:"sec"`
	Temps   []int  `json:"temps"`
	SetTemp int    `json:"set_temp"`
	Blower  int    `json:"blower"`
}

type control struct {
	Name     string `json:"name"`
	Server   string `json:"server"`
	DeviceID *int   `json:"device_id"`
}

// Relay follows devices across Flame Boss's servers.
//
// A controller is not pinned to a server: it connects to whichever one it
// lands on and it moves between them. The entry host is a load balancer, so
// the only way to know where a device is, is to announce on the entry
// connection and read the `connected` messages the control plane sends back --
// one naming the server this connection itself landed on, then one per online
// device naming that device's server. A device on a server we already hold is
// served on that connection; anything else gets a new one.
//
// A fixed bridge to one server FQDN is the thing this replaces. It works right
// up until the device moves, and then it is silent rather than broken.
type Relay struct {
	opts  Options
	state *State
	log   *slog.Logger

	mu      sync.Mutex
	conns   map[string]*conn // server FQDN -> connection
	devices map[int]string   // device id -> server FQDN
	entry   *conn
	logged  map[string]bool // evidence names already logged
}

type conn struct {
	client  mqtt.Client
	fqdn    string
	isEntry bool
	devices map[int]bool
}

type Options struct {
	Host     string
	Port     int
	TLS      bool
	Username string
	Password string
}

// UserID is the account the credentials belong to. The control-plane topics
// are addressed by it, and it is the username minus its `T-` prefix rather
// than a second secret to keep in step.
func (o Options) UserID() string { return strings.TrimPrefix(o.Username, "T-") }

func NewRelay(opts Options, state *State, log *slog.Logger) *Relay {
	return &Relay{
		opts:    opts,
		state:   state,
		log:     log,
		conns:   map[string]*conn{},
		devices: map[int]string{},
		logged:  map[string]bool{},
	}
}

func sendTopics(dev int) []string {
	// Explicit subtopics, not `send/#`: the broker ACL accepts a wildcard
	// subscription and then delivers nothing on it, which looks exactly like a
	// controller that is switched off.
	d := strconv.Itoa(dev)
	return []string{"flameboss/" + d + "/send/open", "flameboss/" + d + "/send/data"}
}

func deviceFromTopic(topic string) (int, bool) {
	parts := strings.Split(topic, "/")
	if len(parts) < 2 || parts[0] != "flameboss" {
		return 0, false
	}
	id, err := strconv.Atoi(parts[1])
	return id, err == nil
}

// Start opens the entry connection. paho reconnects on its own; the connect
// handler re-announces and re-subscribes, because a resumed session is not
// guaranteed to carry either.
func (r *Relay) Start() error {
	c, err := r.dial(r.opts.Host, true)
	if err != nil {
		return err
	}
	r.mu.Lock()
	r.entry = c
	r.mu.Unlock()
	return nil
}

func (r *Relay) dial(host string, isEntry bool) (*conn, error) {
	scheme := "tcp"
	if r.opts.TLS {
		scheme = "tls"
	}
	c := &conn{fqdn: host, isEntry: isEntry, devices: map[int]bool{}}

	o := mqtt.NewClientOptions().
		AddBroker(fmt.Sprintf("%s://%s:%d", scheme, host, r.opts.Port)).
		// Unique per connection: two clients sharing an id kick each other off
		// in a loop that reads as a flapping controller.
		SetClientID(fmt.Sprintf("flameboss-exporter-%d-%d", time.Now().UnixNano(), rand.Intn(1<<16))).
		SetUsername(r.opts.Username).
		SetPassword(r.opts.Password).
		SetCleanSession(true).
		SetKeepAlive(30 * time.Second).
		SetAutoReconnect(true).
		SetMaxReconnectInterval(2 * time.Minute).
		SetConnectRetry(true).
		SetConnectRetryInterval(10 * time.Second).
		SetDefaultPublishHandler(r.onMessage).
		SetOnConnectHandler(func(client mqtt.Client) {
			r.state.SetBrokerConnected(c.fqdn, true)
			r.log.Info("connected", "server", c.fqdn, "entry", isEntry)
			if isEntry {
				r.subscribe(client, "user/"+r.opts.UserID()+"/recv")
				r.announce(client)
			}
			r.mu.Lock()
			devs := make([]int, 0, len(c.devices))
			for dev := range c.devices {
				devs = append(devs, dev)
			}
			r.mu.Unlock()
			for _, dev := range devs {
				for _, t := range sendTopics(dev) {
					r.subscribe(client, t)
				}
			}
		}).
		SetConnectionLostHandler(func(_ mqtt.Client, err error) {
			r.state.SetBrokerConnected(c.fqdn, false)
			r.log.Warn("connection lost", "server", c.fqdn, "err", err)
		})
	if r.opts.TLS {
		o.SetTLSConfig(&tls.Config{ServerName: host, MinVersion: tls.VersionTLS12})
	}

	c.client = mqtt.NewClient(o)
	// With SetConnectRetry the token resolves on the first successful attempt,
	// so a cloud that is down at boot must not be a crash loop: report the
	// error, keep the client, let it retry.
	go func() {
		if t := c.client.Connect(); t.Wait() && t.Error() != nil {
			r.log.Error("connect failed", "server", host, "err", t.Error())
		}
	}()
	return c, nil
}

func (r *Relay) subscribe(client mqtt.Client, topic string) {
	if t := client.Subscribe(topic, 0, nil); t.Wait() && t.Error() != nil {
		r.log.Error("subscribe failed", "topic", topic, "err", t.Error())
		return
	}
	r.log.Debug("subscribed", "topic", topic)
}

func (r *Relay) announce(client mqtt.Client) {
	topic := "user/" + r.opts.UserID() + "/send"
	if t := client.Publish(topic, 0, false, `{"name":"connected"}`); t.Wait() && t.Error() != nil {
		r.log.Error("announce failed", "err", t.Error())
		return
	}
	r.log.Info("announced", "user", r.opts.UserID())
}

// Announce re-asks the control plane where the devices are. Nothing requires
// it -- every server publishes `connected` when a device connects -- but it is
// one small message and it closes the window where a `connected` arrived while
// this process was reconnecting.
func (r *Relay) Announce() {
	r.mu.Lock()
	entry := r.entry
	r.mu.Unlock()
	if entry != nil && entry.client.IsConnected() {
		r.announce(entry.client)
	}
}

func (r *Relay) onMessage(_ mqtt.Client, m mqtt.Message) {
	topic := m.Topic()
	if strings.HasPrefix(topic, "user/") {
		r.onControl(m.Payload())
		return
	}
	dev, ok := deviceFromTopic(topic)
	if !ok {
		return
	}
	var probe struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(m.Payload(), &probe); err != nil || probe.Name == "" {
		r.log.Warn("undecodable uplink", "topic", topic)
		return
	}
	r.state.CountMessage(dev, probe.Name)
	r.logFirst(dev, probe.Name, m.Payload())
	if err := r.apply(dev, probe.Name, m.Payload()); err != nil {
		r.log.Warn("undecodable uplink", "topic", topic, "name", probe.Name, "err", err)
	}
}

// uplink is the union of the fields the modelled messages carry. Each message
// fills only its own; json leaves the rest at their zero values.
type uplink struct {
	Sensor  int      `json:"sensor"`
	Action  string   `json:"action"`
	Enabled *bool    `json:"enabled"`
	Value   *int     `json:"value"`
	Values  []string `json:"values"`
}

// apply turns one uplink into state. Anything not named here is counted and
// otherwise ignored.
func (r *Relay) apply(dev int, name string, payload []byte) error {
	if name == "temps" {
		var t Temps
		if err := json.Unmarshal(payload, &t); err != nil {
			return err
		}
		r.state.Temps(dev, t)
		return nil
	}

	var u uplink
	if err := json.Unmarshal(payload, &u); err != nil {
		return err
	}
	switch name {
	case "labels":
		r.state.Labels(dev, u.Values)
	case "meat_alarm":
		r.state.MeatAlarm(dev, u.Sensor, u.Action)
	case "meat_alarm_triggered":
		r.state.MeatAlarmTriggered(dev, u.Sensor)
	case "pit_alarm":
		if u.Enabled != nil {
			r.state.PitAlarm(dev, *u.Enabled)
		}
	case "pit_alarm_triggered":
		r.state.PitAlarmTriggered(dev)
	case "vent_advice":
		r.state.VentAdvice(dev)
	// The spec marks these deprecated in favour of `open_pit`, but `open_pit`
	// is the lid-pause *setting*, and these two are what this firmware
	// actually publishes when the lid moves.
	case "opened":
		r.state.Lid(dev, true)
	case "closed":
		r.state.Lid(dev, false)
	case "dc_input":
		if u.Value != nil {
			r.state.SupplyVoltage(dev, *u.Value)
		}
	}
	return nil
}

// evidence names the uplinks whose wire format is still unmeasured: a scale
// the spec's examples do not settle, or a message the spec does not list. The
// first of each is logged whole, once per process, so the next cook records
// what they actually carry.
//
// It is an allow-list on purpose. `wifi` carries the network's SSID and may
// carry its key, and a payload logged here ends up in VictoriaLogs.
var evidence = map[string]bool{
	"meat_alarm":   true,
	"pit_alarm":    true,
	"device_temp":  true,
	"dc_input":     true,
	"temp_scale":   true,
	"disconnected": true,
	"cook":         true,
	"mtemps":       true,
}

func (r *Relay) logFirst(dev int, name string, payload []byte) {
	if !evidence[name] {
		return
	}
	r.mu.Lock()
	seen := r.logged[name]
	r.logged[name] = true
	r.mu.Unlock()
	if !seen {
		r.log.Info("first uplink", "device", dev, "name", name, "payload", string(payload))
	}
}

func (r *Relay) onControl(payload []byte) {
	var c control
	if err := json.Unmarshal(payload, &c); err != nil {
		return
	}
	if c.Name != "connected" || c.Server == "" {
		r.log.Debug("control", "name", c.Name)
		return
	}
	if !r.allowedServer(c.Server) {
		r.log.Warn("ignoring server outside the broker's domain", "server", c.Server)
		return
	}
	if c.DeviceID == nil {
		// Device-less: names the server the entry connection itself landed on,
		// so devices there reuse it instead of opening a second connection to
		// a server we are already talking to.
		r.mu.Lock()
		var adopted []int
		if r.entry != nil {
			if r.entry.fqdn != c.Server {
				r.log.Info("entry connection is on server", "server", c.Server)
			}
			delete(r.conns, r.entry.fqdn)
			r.state.ForgetServer(r.entry.fqdn)
			r.entry.fqdn = c.Server
			// A device `connected` can arrive before this message, which dials
			// a second connection to the server the entry connection was
			// already on. Fold it in rather than leave it holding
			// subscriptions nothing will ever reap.
			if dup, ok := r.conns[c.Server]; ok && dup != r.entry {
				for dev := range dup.devices {
					r.entry.devices[dev] = true
					adopted = append(adopted, dev)
				}
				dup.devices = map[int]bool{}
				dup.client.Disconnect(250)
				r.log.Info("folded duplicate connection into the entry connection", "server", c.Server)
			}
			r.conns[c.Server] = r.entry
			r.state.SetBrokerConnected(c.Server, r.entry.client.IsConnected())
		}
		entry := r.entry
		r.mu.Unlock()
		for _, dev := range adopted {
			for _, t := range sendTopics(dev) {
				r.subscribe(entry.client, t)
			}
		}
		return
	}
	r.state.SeeDevice(*c.DeviceID, c.Server)
	r.assign(*c.DeviceID, c.Server)
}

// allowedServer refuses to dial anywhere the control plane names that is not
// the broker's own domain. The server field decides where this process opens a
// connection and sends the account's credentials, so it is checked rather than
// trusted. A bare hostname (a simulator, a LAN broker) has no domain to
// compare and is accepted as given.
func (r *Relay) allowedServer(server string) bool {
	host := r.opts.Host
	if !strings.Contains(host, ".") {
		return true
	}
	return server == host || strings.HasSuffix(server, "."+host)
}

func (r *Relay) assign(dev int, server string) {
	r.mu.Lock()
	if old, ok := r.devices[dev]; ok && old == server {
		r.mu.Unlock()
		return
	} else if ok {
		r.log.Info("device migrating", "device", dev, "from", old, "to", server)
		if c, ok := r.conns[old]; ok {
			c.unsubscribe(dev, r)
			r.reap(c)
		}
	}
	r.devices[dev] = server
	c, held := r.conns[server]
	if !held {
		var err error
		c, err = r.dial(server, false)
		if err != nil {
			r.mu.Unlock()
			r.log.Error("dial failed", "server", server, "err", err)
			return
		}
		r.conns[server] = c
	}
	c.devices[dev] = true
	client := c.client
	r.mu.Unlock()

	// The connect handler subscribes what the connection holds, so a brand new
	// connection needs nothing here; one already up does.
	if held && client.IsConnected() {
		for _, t := range sendTopics(dev) {
			r.subscribe(client, t)
		}
	}
}

func (c *conn) unsubscribe(dev int, r *Relay) {
	delete(c.devices, dev)
	if !c.client.IsConnected() {
		return
	}
	for _, t := range sendTopics(dev) {
		if t := c.client.Unsubscribe(t); t.Wait() && t.Error() != nil {
			r.log.Warn("unsubscribe failed", "err", t.Error())
		}
	}
}

// reap closes a data connection with no devices left on it. The entry
// connection is never reaped: it is the control channel, and without it this
// process stops hearing where devices go.
func (r *Relay) reap(c *conn) {
	if c.isEntry || len(c.devices) > 0 {
		return
	}
	r.log.Info("closing idle connection", "server", c.fqdn)
	c.client.Disconnect(250)
	delete(r.conns, c.fqdn)
	r.state.ForgetServer(c.fqdn)
}

func (r *Relay) Stop() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, c := range r.conns {
		c.client.Disconnect(250)
	}
	if r.entry != nil {
		r.entry.client.Disconnect(250)
	}
}
