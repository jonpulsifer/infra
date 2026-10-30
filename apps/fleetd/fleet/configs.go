package fleet

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"regexp"
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
}

func (p Pending) expired(now time.Time) bool { return now.Sub(p.Rendered) > p.TTL }

// Configs holds the rendered configs in memory, one per machine. Nothing is
// written to disk: a restart drops every unread config, and the node's fetch
// is then a 404 that a new provision answers.
//
// A code whose config is gone, served, expired or replaced, is burned: a
// hash of it is kept for burnFor, and Put refuses it.
type Configs struct {
	mu      sync.Mutex
	pending map[string]Pending
	bytes   map[string][]byte
	burned  map[string]time.Time
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
	c.pending[p.UUID] = p
	c.bytes[p.UUID] = append([]byte(nil), cfg...)
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
	p.Fetched = at
	c.pending[uuid] = p
	delete(c.bytes, uuid)
	c.burn(uuid, code, at)
	return p, true
}

// Released drops a served config's record once NetBox has its release.
func (c *Configs) Released(p Pending) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.init()
	if cur, ok := c.pending[p.UUID]; ok && cur.Code == p.Code && !cur.Fetched.IsZero() {
		delete(c.pending, p.UUID)
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
