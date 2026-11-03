package fleet

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/jonpulsifer/infra/apps/fleetd/classes"
)

// An install code is 32 random bytes as base64url without padding, and a
// machine's UUID is its SMBIOS UUID in lower case, as Talos fills ${uuid}.
var (
	codePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
)

// burnFor is how long a spent code is remembered, so a render under it is
// refused.
const burnFor = 24 * time.Hour

// Pending is a rendered config that waits for its node's first boot: who it
// is for, when it was rendered and how long it waits.
type Pending struct {
	UUID   string
	Code   string
	Serial string
	Node   string
	Class  string
	// Kind is the class's payload kind at the render, which picks the path
	// that serves the config and its content type; a record from before it
	// was kept is a Talos config.
	Kind     string
	Workflow string
	Rendered time.Time
	TTL      time.Duration
	// fetched is when the node fetched it; a fetched config's bytes are
	// gone, and it waits only for its release in NetBox.
	fetched time.Time
	// withdrawn is when the device left planned or NetBox while a fetch
	// held the config. The fetch ends it: its burn records what the node
	// got, and its unclaim drops it.
	withdrawn time.Time
	// claimed is a fetch that is writing the config now; no other fetch
	// gets it meanwhile, and neither the TTL nor a withdrawal drops it.
	claimed bool
}

// pendingJSON is Pending as Dir keeps it, with the fetch and withdrawal
// times under the names an earlier fleetd wrote.
type pendingJSON struct {
	UUID      string
	Code      string
	Serial    string
	Node      string
	Class     string
	Kind      string
	Workflow  string
	Rendered  time.Time
	TTL       time.Duration
	Fetched   time.Time
	Withdrawn time.Time
}

func (p Pending) MarshalJSON() ([]byte, error) {
	return json.Marshal(pendingJSON{p.UUID, p.Code, p.Serial, p.Node, p.Class, p.Kind, p.Workflow, p.Rendered, p.TTL, p.fetched, p.withdrawn})
}

func (p *Pending) UnmarshalJSON(b []byte) error {
	var j pendingJSON
	if err := json.Unmarshal(b, &j); err != nil {
		return err
	}
	*p = Pending{UUID: j.UUID, Code: j.Code, Serial: j.Serial, Node: j.Node, Class: j.Class, Kind: j.Kind, Workflow: j.Workflow, Rendered: j.Rendered, TTL: j.TTL, fetched: j.Fetched, withdrawn: j.Withdrawn}
	return nil
}

// FetchedAt is when the node fetched the config, zero while it waits.
func (p Pending) FetchedAt() time.Time { return p.fetched }

// WithdrawnAt is when a withdrawal found a fetch holding the config, zero
// otherwise.
func (p Pending) WithdrawnAt() time.Time { return p.withdrawn }

func (p Pending) expired(now time.Time) bool { return now.Sub(p.Rendered) > p.TTL }

// what names the config in a journal: a Talos config, a seed, or a
// cloud-init seed.
func (p Pending) what() string {
	switch {
	case p.Kind == classes.PayloadCloudInit:
		return "cloud-init seed"
	case SeedKind(p.Kind):
		return "seed"
	}
	return "Talos config"
}

// contentType is the type the config is served as.
func (p Pending) contentType() string {
	switch {
	case p.Kind == classes.PayloadCloudInit:
		return "application/x-tar"
	case SeedKind(p.Kind):
		return "application/json"
	}
	return "text/yaml"
}

// Served is a config fleetd served: when, and for which node and run. It is
// kept for burnFor under a hash of the machine's UUID and the code, so a node
// that asks again with a spent code is told from one that guesses.
type Served struct {
	At       time.Time
	Node     string
	Serial   string
	Workflow string
}

// Configs holds the rendered configs, one per machine. With Dir set, each
// record and its bytes are also kept as <uuid>.json in Dir, a tmpfs, with
// the burned codes in burned.json, so a restart of the service, such as a
// deploy, keeps every config with its TTL and burn state; a reboot drops
// them. Without Dir they live in memory alone.
//
// A code whose config is gone, served, expired or replaced, is burned: a
// hash of it is kept for burnFor, and Put refuses it. A served code's record
// is kept as long, in served.json.
type Configs struct {
	Dir string

	mu      sync.Mutex
	pending map[string]Pending
	bytes   map[string][]byte
	burned  map[string]time.Time
	served  map[string]Served
}

// configFile is one machine's record in Dir.
type configFile struct {
	Pending Pending `json:"pending"`
	Config  []byte  `json:"config,omitempty"`
}

const (
	burnedFile = "burned.json"
	servedFile = "served.json"
)

// writeAtomic writes a file whole under a temporary name, mode 0600, and
// renames it into place.
func writeAtomic(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// persist writes the machine's record and the burned codes to Dir, or
// removes the record the machine no longer has. The caller holds mu.
func (c *Configs) persist(uuid string) error {
	if c.Dir == "" {
		return nil
	}
	path := filepath.Join(c.Dir, uuid+".json")
	var err error
	if p, ok := c.pending[uuid]; ok {
		var b []byte
		if b, err = json.Marshal(configFile{Pending: p, Config: c.bytes[uuid]}); err == nil {
			err = writeAtomic(path, b)
		}
	} else if rerr := os.Remove(path); rerr != nil && !errors.Is(rerr, os.ErrNotExist) {
		err = rerr
	}
	b, merr := json.Marshal(c.burned)
	if merr == nil {
		merr = writeAtomic(filepath.Join(c.Dir, burnedFile), b)
	}
	s, serr := json.Marshal(c.served)
	if serr == nil {
		serr = writeAtomic(filepath.Join(c.Dir, servedFile), s)
	}
	return errors.Join(err, merr, serr)
}

// keep is persist for a change that already stands in memory: a failure is
// logged, and the next change of the machine writes it again.
func (c *Configs) keep(uuid string) {
	if err := c.persist(uuid); err != nil {
		log.Printf("talos-config: keep %s's record: %v", uuid, err)
	}
}

// Load reads Dir's records and burned codes, as a restart finds them. A
// record that does not parse is skipped and logged.
func (c *Configs) Load() error {
	if c.Dir == "" {
		return nil
	}
	if err := os.MkdirAll(c.Dir, 0o700); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.init()
	for name, into := range map[string]any{burnedFile: &c.burned, servedFile: &c.served} {
		if b, err := os.ReadFile(filepath.Join(c.Dir, name)); err == nil {
			if err := json.Unmarshal(b, into); err != nil {
				return fmt.Errorf("%s: %w", name, err)
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	entries, err := os.ReadDir(c.Dir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		name := e.Name()
		uuid, ok := strings.CutSuffix(name, ".json")
		if !ok || !uuidPattern.MatchString(uuid) {
			continue
		}
		b, err := os.ReadFile(filepath.Join(c.Dir, name))
		var f configFile
		if err == nil {
			err = json.Unmarshal(b, &f)
		}
		if err != nil || f.Pending.UUID != uuid {
			log.Printf("talos-config: skip %s: %v", name, err)
			continue
		}
		if c.settleCrashedClaim(f.Pending) {
			continue
		}
		c.pending[uuid] = f.Pending
		if f.Pending.fetched.IsZero() {
			c.bytes[uuid] = f.Config
		}
	}
	return nil
}

// ErrBurned is a render for a code whose config is already gone.
var ErrBurned = errors.New("the code is spent")

func burnKey(uuid, code string) string {
	h := sha256.Sum256([]byte(uuid + "/" + code))
	return hex.EncodeToString(h[:])
}

func (c *Configs) init() {
	if c.pending == nil {
		c.pending, c.bytes, c.burned = map[string]Pending{}, map[string][]byte{}, map[string]time.Time{}
	}
	if c.served == nil {
		c.served = map[string]Served{}
	}
}

// burn records a spent code and forgets the spent and served ones older
// than burnFor.
func (c *Configs) burn(uuid, code string, at time.Time) {
	c.burned[burnKey(uuid, code)] = at
	for k, t := range c.burned {
		if at.Sub(t) > burnFor {
			delete(c.burned, k)
		}
	}
	for k, s := range c.served {
		if at.Sub(s.At) > burnFor {
			delete(c.served, k)
		}
	}
}

// Put keeps a config for its machine. A machine has one config at a time:
// an older code's config goes and its code is burned, since only the newest
// code is in its META.
func (c *Configs) Put(p Pending, cfg []byte) error {
	if !uuidPattern.MatchString(p.UUID) || !codePattern.MatchString(p.Code) {
		return errors.New("the uuid or the code is malformed")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.init()
	if _, spent := c.burned[burnKey(p.UUID, p.Code)]; spent {
		return ErrBurned
	}
	if old, ok := c.pending[p.UUID]; ok {
		if old.Code == p.Code {
			return ErrBurned
		}
		if old.fetched.IsZero() {
			c.burn(old.UUID, old.Code, p.Rendered)
		}
	}
	p.fetched = time.Time{}
	old, hadOld := c.pending[p.UUID]
	oldBytes := c.bytes[p.UUID]
	c.pending[p.UUID] = p
	c.bytes[p.UUID] = append([]byte(nil), cfg...)
	if err := c.persist(p.UUID); err != nil {
		if hadOld {
			c.pending[p.UUID], c.bytes[p.UUID] = old, oldBytes
		} else {
			delete(c.pending, p.UUID)
			delete(c.bytes, p.UUID)
		}
		return fmt.Errorf("keep the config: %w", err)
	}
	return nil
}

// Spent says whether the code is burned.
func (c *Configs) Spent(uuid, code string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.init()
	_, ok := c.burned[burnKey(uuid, code)]
	return ok
}

// Get returns the unread, unexpired config for the machine and code.
func (c *Configs) Get(uuid, code string, now time.Time) (Pending, []byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.init()
	p, ok := c.pending[uuid]
	if !ok || p.Code != code || !p.fetched.IsZero() || p.expired(now) {
		return Pending{}, nil, false
	}
	return p, c.bytes[uuid], true
}

// claim is Get for one fetch at a time: a config another fetch is writing
// answers nothing until that fetch burns it or gives it back.
func (c *Configs) claim(uuid, code string, now time.Time) (Pending, []byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.init()
	p, ok := c.pending[uuid]
	if !ok || p.Code != code || !p.fetched.IsZero() || p.claimed || !p.withdrawn.IsZero() || p.expired(now) {
		return Pending{}, nil, false
	}
	p.claimed = true
	c.pending[uuid] = p
	return p, c.bytes[uuid], true
}

// unclaim gives a config back after a fetch that did not deliver it, and
// says whether it stays for another fetch. A config withdrawn during the
// fetch is dropped and burned now.
func (c *Configs) unclaim(uuid, code string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.init()
	p, ok := c.pending[uuid]
	if !ok || p.Code != code || !p.fetched.IsZero() {
		return false
	}
	if !p.withdrawn.IsZero() {
		delete(c.pending, uuid)
		delete(c.bytes, uuid)
		c.burn(uuid, code, p.withdrawn)
		c.keep(uuid)
		return false
	}
	p.claimed = false
	c.pending[uuid] = p
	return true
}

// settleCrashedClaim resolves a record Load reads whose fetch ended with the
// process while a withdrawal held it: the config is burned, as the fetch's
// unclaim would have done. It says whether it settled the record.
func (c *Configs) settleCrashedClaim(p Pending) bool {
	if !p.fetched.IsZero() || p.withdrawn.IsZero() {
		return false
	}
	c.burn(p.UUID, p.Code, p.withdrawn)
	c.keep(p.UUID)
	return true
}

// Fetch is one node's ask for its config and the three things Serve cannot
// know itself.
type Fetch struct {
	UUID, Code string
	Now        time.Time
	// Serves says whether the path asked serves a config of the payload kind.
	Serves func(kind string) bool
	// Check says whether the config is still wanted.
	Check func(Pending) Verdict
	// Deliver writes the config whole and returns once the node has
	// acknowledged it, or says why it did not.
	Deliver func(Pending, []byte) error
}

// VerdictKind is the answer of a Fetch's Check.
type VerdictKind int

const (
	// Wanted keeps the fetch going.
	Wanted VerdictKind = iota
	// Gone is a device NetBox no longer holds, or one that left planned.
	Gone
	// Unavailable is a NetBox that does not answer: the config stays.
	Unavailable
)

// Verdict is a Check's answer. Settle, when set, runs once Serve has given
// the config back, so a withdrawal it makes finds it unclaimed.
type Verdict struct {
	Kind   VerdictKind
	Settle func()
}

// OutcomeKind says how a Serve ended.
type OutcomeKind int

const (
	// Absent is no config for the machine and code, or one another fetch holds.
	Absent OutcomeKind = iota
	// WrongPath is a config the path does not serve; it stays.
	WrongPath
	// Refused is a config the Check found gone; it was given back and settled.
	Refused
	// Unreachable is a Check that could not tell; the config was given back.
	Unreachable
	// Undelivered is a write the node did not acknowledge whole.
	Undelivered
	// Replaced is a config a newer render replaced during the fetch.
	Replaced
	// Delivered is a config the node got whole; it is burned.
	Delivered
)

// Outcome is what Serve did.
type Outcome struct {
	Kind    OutcomeKind
	Pending Pending
	// Err is the delivery's failure.
	Err error
	// Stays is whether a config given back is still there for another
	// fetch, or was withdrawn during this one and is dropped.
	Stays bool
}

// Serve runs one fetch: it claims the config, asks Check whether it is still
// wanted, has Deliver write it, and burns it once the node acknowledged
// every byte. Any other end gives the config back. The caller maps the
// outcome to an answer and a journal.
func (c *Configs) Serve(f Fetch) Outcome {
	p, cfg, ok := c.claim(f.UUID, f.Code, f.Now)
	if !ok {
		return Outcome{Kind: Absent}
	}
	if !f.Serves(p.Kind) {
		c.unclaim(f.UUID, f.Code)
		return Outcome{Kind: WrongPath, Pending: p}
	}
	switch v := f.Check(p); v.Kind {
	case Gone:
		c.unclaim(f.UUID, f.Code)
		if v.Settle != nil {
			v.Settle()
		}
		return Outcome{Kind: Refused, Pending: p}
	case Unavailable:
		return Outcome{Kind: Unreachable, Pending: p, Stays: c.unclaim(f.UUID, f.Code)}
	}
	if err := f.Deliver(p, cfg); err != nil {
		return Outcome{Kind: Undelivered, Pending: p, Err: err, Stays: c.unclaim(f.UUID, f.Code)}
	}
	served, ok := c.consume(f.UUID, f.Code, f.Now)
	if !ok {
		return Outcome{Kind: Replaced, Pending: p}
	}
	return Outcome{Kind: Delivered, Pending: served}
}

// consume marks the machine's config served: its bytes go, its code is burned,
// and its record waits for Released. ok is false when the config is no
// longer the one asked for. A config withdrawn during the fetch burns too,
// with withdrawn set.
func (c *Configs) consume(uuid, code string, at time.Time) (Pending, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.init()
	p, ok := c.pending[uuid]
	if !ok || p.Code != code || !p.fetched.IsZero() {
		return Pending{}, false
	}
	p.fetched, p.claimed = at, false
	c.pending[uuid] = p
	delete(c.bytes, uuid)
	c.served[burnKey(uuid, code)] = Served{At: at, Node: p.Node, Serial: p.Serial, Workflow: p.Workflow}
	c.burn(uuid, code, at)
	c.keep(uuid)
	return p, true
}

// Served returns the record of the config served under the machine's code
// within burnFor.
func (c *Configs) Served(uuid, code string) (Served, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.init()
	s, ok := c.served[burnKey(uuid, code)]
	return s, ok
}

// Released drops a served config's record once NetBox has its release.
func (c *Configs) Released(p Pending) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.init()
	if cur, ok := c.pending[p.UUID]; ok && cur.Code == p.Code && !cur.fetched.IsZero() {
		delete(c.pending, p.UUID)
		c.keep(p.UUID)
	}
}

// Holds says whether the machine has an unread config.
func (c *Configs) Holds(uuid string) (Pending, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.init()
	p, ok := c.pending[uuid]
	return p, ok && p.fetched.IsZero()
}

// Event is something that happened to a pending config outside a fetch: the
// caller journals it.
type Event struct {
	Kind    EventKind
	Pending Pending
	// Reason is the sentence a Sweep's predicate gave for the withdrawal.
	Reason string
}

// EventKind says what an Event is.
type EventKind int

const (
	// Expired is an unread config dropped and burned past its TTL.
	Expired EventKind = iota + 1
	// Withdrawn is an unread config dropped and burned because its device
	// left planned or NetBox, or its Workflow ended.
	Withdrawn
	// WithdrawnWhileFetching is a config a fetch holds, marked withdrawn:
	// the fetch may have written it, and its end drops it.
	WithdrawnWhileFetching
)

// Tick drops and burns every unread config past its TTL, and returns them as
// Expired events. The TTL bounds when a fetch may start: a config a fetch
// holds ends in its consume or unclaim, and a later pass expires it if it
// stays.
func (c *Configs) Tick(now time.Time) []Event {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.init()
	var out []Event
	for uuid, p := range c.pending {
		if p.fetched.IsZero() && !p.claimed && p.expired(now) {
			delete(c.pending, uuid)
			delete(c.bytes, uuid)
			c.burn(p.UUID, p.Code, now)
			c.keep(uuid)
			out = append(out, Event{Kind: Expired, Pending: p})
		}
	}
	return out
}

// Withdraw drops and burns the unread config of the machine with the serial,
// and says so. A config a fetch holds is marked withdrawn instead, and the
// event says so: the fetch may have written it, and its end drops it. ok is
// false when the machine has no unread config to withdraw.
func (c *Configs) Withdraw(serial string, now time.Time) (ev Event, ok bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.init()
	for uuid, p := range c.pending {
		if p.Serial != serial || !p.fetched.IsZero() || !p.withdrawn.IsZero() {
			continue
		}
		if p.claimed {
			p.withdrawn = now
			c.pending[uuid] = p
			c.keep(uuid)
			return Event{Kind: WithdrawnWhileFetching, Pending: p}, true
		}
		delete(c.pending, uuid)
		delete(c.bytes, uuid)
		c.burn(p.UUID, p.Code, now)
		c.keep(uuid)
		return Event{Kind: Withdrawn, Pending: p}, true
	}
	return Event{}, false
}

// Sweep withdraws each unread config for which why gives a reason, and
// returns the events with their reasons.
func (c *Configs) Sweep(now time.Time, why func(Pending) string) []Event {
	var out []Event
	for _, p := range c.unread() {
		reason := why(p)
		if reason == "" {
			continue
		}
		if ev, ok := c.Withdraw(p.Serial, now); ok {
			ev.Reason = reason
			out = append(out, ev)
		}
	}
	return out
}

// unread lists the configs no node has fetched and none withdrew.
func (c *Configs) unread() []Pending {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.init()
	var out []Pending
	for _, p := range c.pending {
		if p.fetched.IsZero() && p.withdrawn.IsZero() {
			out = append(out, p)
		}
	}
	return out
}

// Unreleased lists the served configs NetBox has no release for.
func (c *Configs) Unreleased() []Pending {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.init()
	var out []Pending
	for _, p := range c.pending {
		if !p.fetched.IsZero() {
			out = append(out, p)
		}
	}
	return out
}

// Stats counts the unread configs and the served, unreleased ones, with the
// render time of the oldest unread and the fetch time of the oldest
// unreleased.
func (c *Configs) Stats() (unread int, oldestUnread time.Time, unreleased int, oldestUnreleased time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.init()
	for _, p := range c.pending {
		if p.fetched.IsZero() {
			if !p.withdrawn.IsZero() {
				continue
			}
			unread++
			if oldestUnread.IsZero() || p.Rendered.Before(oldestUnread) {
				oldestUnread = p.Rendered
			}
			continue
		}
		unreleased++
		if oldestUnreleased.IsZero() || p.fetched.Before(oldestUnreleased) {
			oldestUnreleased = p.fetched
		}
	}
	return
}
