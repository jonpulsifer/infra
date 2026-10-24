package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"math/big"
	"sort"
	"strings"
	"sync"
	"time"
)

// RFC 8628 §6.1: consonants only, so a user code never spells a word.
const userCodeAlphabet = "BCDFGHJKLMNPQRSTVWXZ"

type phase int

const (
	phasePending phase = iota
	phaseApproved
	phaseDenied
	phaseSuperseded
	phaseServed
	phaseExpired
)

func (p phase) String() string {
	return [...]string{"pending", "approved", "denied", "superseded", "served", "expired"}[p]
}

// Device is what Talos asserts about itself on the device request. Nothing in
// it is verified, so it binds a token only through the UUID.
type Device struct {
	UUID     string `json:"uuid"`
	MAC      string `json:"mac"`
	Serial   string `json:"serial"`
	Hostname string `json:"hostname"`
}

type enrollment struct {
	deviceCode   string
	userCode     string
	device       Device
	expires      time.Time
	phase        phase
	node         string
	approver     string
	token        string
	tokenExpires time.Time
	config       []byte
}

// Enrollment is a read-only view of one enrollment for the approval page and
// the notifier.
type Enrollment struct {
	UserCode  string    `json:"user_code"`
	Device    Device    `json:"device"`
	Phase     string    `json:"phase"`
	Expires   time.Time `json:"expires"`
	Node      string    `json:"node,omitempty"`
	Approver  string    `json:"approver,omitempty"`
	Suggested string    `json:"suggested_node,omitempty"`
}

// OAuthError is an RFC 6749 §5.2 error body with the status it is sent with.
type OAuthError struct {
	Status      int    `json:"-"`
	Code        string `json:"error"`
	Description string `json:"error_description,omitempty"`
}

func (e *OAuthError) Error() string { return e.Code + ": " + e.Description }

func oauthErr(status int, code, desc string) *OAuthError {
	return &OAuthError{Status: status, Code: code, Description: desc}
}

var (
	ErrUnknownCode = errors.New("no enrollment has that user code")
	ErrNotPending  = errors.New("the enrollment is no longer waiting for approval")
	ErrUnknownNode = errors.New("no machine inputs name that node")
	ErrBadToken    = errors.New("the token is unknown, used or expired")
	ErrWrongUUID   = errors.New("the token is bound to another uuid")
)

// Store holds the device flow's state in memory. A restart forgets every
// enrollment, and Talos then starts a new device flow on its own.
type Store struct {
	mu       sync.Mutex
	now      func() time.Time
	codeTTL  time.Duration
	tokenTTL time.Duration
	interval time.Duration
	maxLive  int

	byDevice map[string]*enrollment
	byUser   map[string]*enrollment
	byToken  map[string]*enrollment
	live     map[string]*enrollment
	denied   map[string]bool
	served   map[string]time.Time

	stats *Stats
}

// Stats counts what the store did, for /metrics.
type Stats struct {
	DeviceCodes, Approvals, Denials, Superseded, Served uint64
	Expired                                             map[string]uint64
	Refused                                             map[string]uint64
}

func NewStore(now func() time.Time) *Store {
	return &Store{
		now:      now,
		codeTTL:  15 * time.Minute,
		tokenTTL: 30 * time.Minute,
		interval: 5 * time.Second,
		maxLive:  32,
		byDevice: map[string]*enrollment{},
		byUser:   map[string]*enrollment{},
		byToken:  map[string]*enrollment{},
		live:     map[string]*enrollment{},
		denied:   map[string]bool{},
		served:   map[string]time.Time{},
		stats:    &Stats{Expired: map[string]uint64{}, Refused: map[string]uint64{}},
	}
}

func normUUID(s string) string { return strings.ToLower(strings.TrimSpace(s)) }

func normUserCode(s string) string {
	s = strings.ToUpper(strings.NewReplacer("-", "", " ", "").Replace(s))
	if len(s) != 8 {
		return s
	}
	return s[:4] + "-" + s[4:]
}

func hashToken(t string) string {
	sum := sha256.Sum256([]byte(t))
	return hex.EncodeToString(sum[:])
}

func randomToken() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func randomUserCode() string {
	var b strings.Builder
	max := big.NewInt(int64(len(userCodeAlphabet)))
	for i := range 8 {
		if i == 4 {
			b.WriteByte('-')
		}
		n, _ := rand.Int(rand.Reader, max)
		b.WriteByte(userCodeAlphabet[n.Int64()])
	}
	return b.String()
}

// Start records a device request. A newer request for the same UUID
// supersedes the older one, so one prompt per machine waits at a time.
func (s *Store) Start(d Device) (Enrollment, string, *OAuthError) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepLocked()

	key := normUUID(d.UUID)
	if s.denied[key] {
		s.stats.Refused["denied_uuid"]++
		return Enrollment{}, "", oauthErr(403, "access_denied", "the owner denied this machine")
	}
	if old := s.live[key]; old != nil {
		s.retireLocked(old, phaseSuperseded)
		s.stats.Superseded++
	}
	if len(s.live) >= s.maxLive {
		return Enrollment{}, "", oauthErr(503, "temporarily_unavailable", "too many enrollments are waiting")
	}

	e := &enrollment{
		deviceCode: randomToken(),
		device:     d,
		expires:    s.now().Add(s.codeTTL),
		phase:      phasePending,
	}
	for {
		e.userCode = randomUserCode()
		if s.byUser[e.userCode] == nil {
			break
		}
	}
	s.byDevice[e.deviceCode] = e
	s.byUser[e.userCode] = e
	s.live[key] = e
	s.stats.DeviceCodes++
	return e.view(), e.deviceCode, nil
}

// Poll answers one token request. Both requests of Talos's pair get the same
// answer, because a poll never changes state.
func (s *Store) Poll(deviceCode, uuid string) (string, time.Duration, *OAuthError) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepLocked()

	e := s.byDevice[deviceCode]
	if e == nil {
		return "", 0, oauthErr(400, "invalid_grant", "unknown device_code")
	}
	if uuid != "" && normUUID(uuid) != normUUID(e.device.UUID) {
		return "", 0, oauthErr(400, "invalid_grant", "device_code was issued to another uuid")
	}
	switch e.phase {
	case phasePending:
		return "", 0, oauthErr(400, "authorization_pending", "")
	case phaseApproved:
		// The token is minted at approval, and every poll returns it until it
		// expires, so a lost response is answered again.
		return e.token, e.tokenExpires.Sub(s.now()), nil
	case phaseDenied:
		return "", 0, oauthErr(400, "access_denied", "the owner denied this machine")
	default:
		return "", 0, oauthErr(400, "expired_token", "device_code is no longer valid")
	}
}

// Lookup returns the pending enrollment for a user code.
func (s *Store) Lookup(userCode string) (Enrollment, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepLocked()
	e := s.byUser[normUserCode(userCode)]
	if e == nil {
		return Enrollment{}, ErrUnknownCode
	}
	if e.phase != phasePending {
		return e.view(), ErrNotPending
	}
	return e.view(), nil
}

// Approve binds a rendered config and a fresh token to the enrollment. The
// caller renders first, so a token exists only for a config that rendered.
func (s *Store) Approve(userCode, node, approver string, config []byte) (Enrollment, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepLocked()

	e := s.byUser[normUserCode(userCode)]
	if e == nil {
		return Enrollment{}, "", ErrUnknownCode
	}
	if e.phase != phasePending {
		return e.view(), "", ErrNotPending
	}
	e.phase = phaseApproved
	e.node = node
	e.approver = approver
	e.config = config
	e.token = randomToken()
	e.tokenExpires = s.now().Add(s.tokenTTL)
	s.byToken[hashToken(e.token)] = e
	s.stats.Approvals++
	return e.view(), e.token, nil
}

// Deny refuses the enrollment and every later device request from its UUID
// until the server restarts.
func (s *Store) Deny(userCode, approver string) (Enrollment, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepLocked()

	e := s.byUser[normUserCode(userCode)]
	if e == nil {
		return Enrollment{}, ErrUnknownCode
	}
	if e.phase != phasePending && e.phase != phaseApproved {
		return e.view(), ErrNotPending
	}
	e.approver = approver
	s.denied[normUUID(e.device.UUID)] = true
	s.retireLocked(e, phaseDenied)
	s.stats.Denials++
	return e.view(), nil
}

// Config returns the bound config for a token and the UUID in the request.
func (s *Store) Config(token, uuid string) ([]byte, Enrollment, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepLocked()

	e := s.byToken[hashToken(token)]
	if e == nil || e.phase != phaseApproved || !s.now().Before(e.tokenExpires) {
		s.stats.Refused["bad_token"]++
		return nil, Enrollment{}, ErrBadToken
	}
	if normUUID(uuid) != normUUID(e.device.UUID) {
		s.stats.Refused["wrong_uuid"]++
		return nil, e.view(), ErrWrongUUID
	}
	return e.config, e.view(), nil
}

// Consume spends a token after its config was written in full. A write that
// failed leaves the token valid, since Talos retries with the same one.
func (s *Store) Consume(token string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.byToken[hashToken(token)]
	if e == nil || e.phase != phaseApproved {
		return
	}
	s.served[e.node] = s.now()
	s.stats.Served++
	s.retireLocked(e, phaseServed)
}

// List returns the enrollments still waiting on the owner or on Talos.
func (s *Store) List() []Enrollment {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepLocked()
	out := make([]Enrollment, 0, len(s.live))
	for _, e := range s.live {
		out = append(out, e.view())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Expires.Before(out[j].Expires) })
	return out
}

// Gauges reports the live counts and each node's last config fetch.
func (s *Store) Gauges() (pending, approved int, served map[string]time.Time, st Stats) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepLocked()
	for _, e := range s.live {
		switch e.phase {
		case phasePending:
			pending++
		case phaseApproved:
			approved++
		}
	}
	served = make(map[string]time.Time, len(s.served))
	for k, v := range s.served {
		served[k] = v
	}
	st = *s.stats
	st.Expired = cloneCounts(s.stats.Expired)
	st.Refused = cloneCounts(s.stats.Refused)
	return pending, approved, served, st
}

func (s *Store) refuse(reason string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stats.Refused[reason]++
}

func cloneCounts(m map[string]uint64) map[string]uint64 {
	out := make(map[string]uint64, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

func (s *Store) retireLocked(e *enrollment, p phase) {
	e.phase = p
	e.config = nil
	if s.live[normUUID(e.device.UUID)] == e {
		delete(s.live, normUUID(e.device.UUID))
	}
	if e.token != "" {
		delete(s.byToken, hashToken(e.token))
		e.token = ""
	}
}

// sweepLocked expires codes and tokens. A code is forgotten an interval
// after expiry, so Talos's last poll still reads expired_token.
func (s *Store) sweepLocked() {
	now := s.now()
	for code, e := range s.byDevice {
		switch {
		case e.phase == phasePending && !now.Before(e.expires):
			s.stats.Expired["device_code"]++
			s.retireLocked(e, phaseExpired)
		case e.phase == phaseApproved && !now.Before(e.tokenExpires):
			s.stats.Expired["token"]++
			s.retireLocked(e, phaseExpired)
		}
		end := e.expires
		if e.tokenExpires.After(end) {
			end = e.tokenExpires
		}
		if now.After(end.Add(s.codeTTL)) {
			delete(s.byDevice, code)
			if s.byUser[e.userCode] == e {
				delete(s.byUser, e.userCode)
			}
		}
	}
}

func (e *enrollment) view() Enrollment {
	return Enrollment{
		UserCode: e.userCode,
		Device:   e.device,
		Phase:    e.phase.String(),
		Expires:  e.expires,
		Node:     e.node,
		Approver: e.approver,
	}
}
