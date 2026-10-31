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
	UUID     string
	Code     string
	Serial   string
	Node     string
	Class    string
	Workflow string
	Rendered time.Time
	TTL      time.Duration
	// Fetched is when the node fetched it; a fetched config's bytes are
	// gone, and it waits only for its release in NetBox.
	Fetched time.Time
	// claimed is a fetch that is writing the config now; no other fetch
	// gets it meanwhile.
	claimed bool
}

func (p Pending) expired(now time.Time) bool { return now.Sub(p.Rendered) > p.TTL }

// Configs holds the rendered configs, one per machine. With Dir set, each
// record and its bytes are also kept as <uuid>.json in Dir, a tmpfs, with
// the burned codes in burned.json, so a restart of the service, such as a
// deploy, keeps every config with its TTL and burn state; a reboot drops
// them. Without Dir they live in memory alone.
//
// A code whose config is gone, served, expired or replaced, is burned: a
// hash of it is kept for burnFor, and Put refuses it.
type Configs struct {
	Dir string

	mu      sync.Mutex
	pending map[string]Pending
	bytes   map[string][]byte
	burned  map[string]time.Time
}

// configFile is one machine's record in Dir.
type configFile struct {
	Pending Pending `json:"pending"`
	Config  []byte  `json:"config,omitempty"`
}

const burnedFile = "burned.json"

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
	return errors.Join(err, merr)
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
	if b, err := os.ReadFile(filepath.Join(c.Dir, burnedFile)); err == nil {
		if err := json.Unmarshal(b, &c.burned); err != nil {
			return fmt.Errorf("%s: %w", burnedFile, err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	entries, err := os.ReadDir(c.Dir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		name := e.Name()
		uuid, ok := strings.CutSuffix(name, ".json")
		if !ok || name == burnedFile || !uuidPattern.MatchString(uuid) {
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
		c.pending[uuid] = f.Pending
		if f.Pending.Fetched.IsZero() {
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
}

// burn records a spent code and forgets the ones older than burnFor.
func (c *Configs) burn(uuid, code string, at time.Time) {
	c.burned[burnKey(uuid, code)] = at
	for k, t := range c.burned {
		if at.Sub(t) > burnFor {
			delete(c.burned, k)
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
		if old.Fetched.IsZero() {
			c.burn(old.UUID, old.Code, p.Rendered)
		}
	}
	p.Fetched = time.Time{}
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
	if !ok || p.Code != code || !p.Fetched.IsZero() || p.expired(now) {
		return Pending{}, nil, false
	}
	return p, c.bytes[uuid], true
}

// Claim is Get for one fetch at a time: a config another fetch is writing
// answers nothing until that fetch burns it or gives it back.
func (c *Configs) Claim(uuid, code string, now time.Time) (Pending, []byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.init()
	p, ok := c.pending[uuid]
	if !ok || p.Code != code || !p.Fetched.IsZero() || p.claimed || p.expired(now) {
		return Pending{}, nil, false
	}
	p.claimed = true
	c.pending[uuid] = p
	return p, c.bytes[uuid], true
}

// Unclaim gives a config back after a fetch that did not write all of it.
func (c *Configs) Unclaim(uuid, code string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.init()
	if p, ok := c.pending[uuid]; ok && p.Code == code {
		p.claimed = false
		c.pending[uuid] = p
	}
}

// Burn marks the machine's config served: its bytes go, its code is burned,
// and its record waits for Released. ok is false when the config is no
// longer the one asked for.
func (c *Configs) Burn(uuid, code string, at time.Time) (Pending, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.init()
	p, ok := c.pending[uuid]
	if !ok || p.Code != code || !p.Fetched.IsZero() {
		return Pending{}, false
	}
	p.Fetched, p.claimed = at, false
	c.pending[uuid] = p
	delete(c.bytes, uuid)
	c.burn(uuid, code, at)
	c.keep(uuid)
	return p, true
}

// Released drops a served config's record once NetBox has its release.
func (c *Configs) Released(p Pending) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.init()
	if cur, ok := c.pending[p.UUID]; ok && cur.Code == p.Code && !cur.Fetched.IsZero() {
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
	return p, ok && p.Fetched.IsZero()
}

// Expire drops and burns every unread config past its TTL, and returns them.
func (c *Configs) Expire(now time.Time) []Pending {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.init()
	var out []Pending
	for uuid, p := range c.pending {
		if p.Fetched.IsZero() && p.expired(now) {
			delete(c.pending, uuid)
			delete(c.bytes, uuid)
			c.burn(p.UUID, p.Code, now)
			c.keep(uuid)
			out = append(out, p)
		}
	}
	return out
}

// Drop drops and burns the unread config of the machine with the serial, and
// returns it.
func (c *Configs) Drop(serial string, now time.Time) (Pending, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.init()
	for uuid, p := range c.pending {
		if p.Serial == serial && p.Fetched.IsZero() {
			delete(c.pending, uuid)
			delete(c.bytes, uuid)
			c.burn(p.UUID, p.Code, now)
			c.keep(uuid)
			return p, true
		}
	}
	return Pending{}, false
}

// Unread lists the configs no node has fetched.
func (c *Configs) Unread() []Pending {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.init()
	var out []Pending
	for _, p := range c.pending {
		if p.Fetched.IsZero() {
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
		if !p.Fetched.IsZero() {
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
		if p.Fetched.IsZero() {
			unread++
			if oldestUnread.IsZero() || p.Rendered.Before(oldestUnread) {
				oldestUnread = p.Rendered
			}
			continue
		}
		unreleased++
		if oldestUnreleased.IsZero() || p.Fetched.Before(oldestUnreleased) {
			oldestUnreleased = p.Fetched
		}
	}
	return
}
