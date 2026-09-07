// smiirl stands in for api.smiirl.com so a Smiirl flip counter (firmware
// smiirl-2.0.7-1) runs without Smiirl's cloud. It answers the routes the
// firmware calls over plain HTTP and exposes a small JSON API plus a web page
// for setting what the five flap drums show.
package main

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"maps"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
	_ "time/tzdata" // the distroless image ships no zoneinfo
)

//go:embed index.html
var indexHTML []byte

//go:embed manifest.webmanifest
var manifestJSON []byte

//go:embed icon.svg
var iconSVG []byte

//go:embed sw.js
var serviceWorkerJS []byte

// pollTimeout bounds how long a firmware poll is held waiting for a change.
// The cloud holds ~17 s and the device re-polls ~20 s after the previous
// request started; 12 s leaves headroom for the round trip and stays under
// Envoy's 15 s default route timeout even where the HTTPRoute's own timeout
// is not honoured.
var pollTimeout = 12 * time.Second

// flapSettle is the least time between two different values handed to the
// device. A drum needs a few seconds per flip and a full turn to reach a
// lower digit; a new value arriving mid-turn has left drums out of step with
// what the firmware believes they show.
var flapSettle = 10 * time.Second

const (
	maxNumber  = 99999 // the counter has five drums
	blankCells = "aaaa0"
	defaultAt  = "08:00"
	maxCatchUp = 366 // daily steps applied at once after downtime
	dayFormat  = "2006-01-02"
	// minFormat is a countdown target, in the shape the page's
	// datetime-local input hands over.
	minFormat    = "2006-01-02T15:04"
	maxCountdown = 99*60 + 59 // minutes the drums hold as HHbMM
	defaultEvery = 5          // minutes a cycle holds each mode
	maxEvery     = 1440
)

// modes is everything the drums can show. A cycle rotates through the others,
// never through itself.
var modes = []string{"number", "clock", "days", "date", "countdown", "github", "cycle"}

var cyclable = modes[:len(modes)-1]

var (
	macRe = regexp.MustCompile(`^[0-9a-f]{12}$`)
	hexRe = regexp.MustCompile(`^[0-9a-f]+$`)
	// Each drum has twelve flaps: the digits, a blank ('a') and a striped
	// one ('b'); a cells value addresses all five drums.
	cellsRe = regexp.MustCompile(`^[0-9ab]{5}$`)
	// A canonical number: leading blanks, then digits without a leading zero.
	numberRe = regexp.MustCompile(`^a*(0|[1-9][0-9]*)$`)
	atRe     = regexp.MustCompile(`^([01][0-9]|2[0-3]):[0-5][0-9]$`)
	// A GitHub login: alphanumerics and inner hyphens, up to 39 characters.
	userRe = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$`)
)

type daily struct {
	Step int    `json:"step"`
	At   string `json:"at"`
	Last string `json:"last"` // date of the last boundary applied
}

// cycle is the rotation: each mode in Modes holds the drums for Every
// minutes, in turn.
type cycle struct {
	Modes []string `json:"modes"`
	Every int      `json:"every"`
}

// github counts a person's public commits or pull requests. Count and At are
// kept so a restart shows the last number instead of blanking the drums while
// the first fetch is out.
type github struct {
	User  string    `json:"user"`
	What  string    `json:"what"` // commits or prs
	Count int       `json:"count"`
	At    time.Time `json:"at"`
	Err   string    `json:"-"` // the last fetch failure, for the page; not persisted
}

// persisted is number.json. Cells is the stored number whatever the mode; the
// daily step keeps moving it while another mode has the drums.
type persisted struct {
	Cells       string    `json:"cells"`
	UpdatedAt   time.Time `json:"updatedAt"`
	Daily       daily     `json:"daily"`
	Mode        string    `json:"mode"`                  // one of modes
	DaysDate    string    `json:"daysDate,omitempty"`    // the date days mode counts to
	Clock12     bool      `json:"clock12,omitempty"`     // clock mode shows a 12-hour time
	CountdownAt string    `json:"countdownAt,omitempty"` // the moment countdown mode runs to
	Cycle       cycle     `json:"cycle"`
	GitHub      github    `json:"github"`
}

// shows reports whether p has what mode m needs. A mode that wants a setting
// is not offered, kept or rotated to until the setting is there.
func (p persisted) shows(m string) bool {
	switch m {
	case "number", "clock", "date":
		return true
	case "days":
		return p.DaysDate != ""
	case "countdown":
		return p.CountdownAt != ""
	case "github":
		return p.GitHub.User != ""
	case "cycle":
		return len(p.Cycle.Modes) >= 2
	}
	return false
}

// cycleMode is the member holding the drums at now. The turns are keyed to
// the wall clock rather than to a timer, so nothing has to be scheduled and a
// restart lands back in the rotation where it left off.
func (p persisted) cycleMode(now time.Time) string {
	turn := now.Unix() / int64(p.Cycle.Every*60)
	return p.Cycle.Modes[int(turn%int64(len(p.Cycle.Modes)))]
}

// keepCyclable is ms with anything a cycle cannot rotate to dropped: another
// cycle, a repeat, and any mode whose setting is missing.
func keepCyclable(p persisted, ms []string) []string {
	keep := []string{}
	for _, m := range ms {
		if slices.Contains(cyclable, m) && !slices.Contains(keep, m) && p.shows(m) {
			keep = append(keep, m)
		}
	}
	return keep
}

type server struct {
	path string // number.json
	loc  *time.Location
	now  func() time.Time

	mu         sync.Mutex
	persisted  persisted
	lastPoll   time.Time
	lastSent   string // cells last answered to the device; single device, so one is enough
	lastSentAt time.Time
	devHost    string
	lastStatus json.RawMessage
	changed    chan struct{} // closed and replaced whenever cells change
}

func newServer(dataDir string, loc *time.Location) (*server, error) {
	s := &server{devHost: envOr("SMIIRL_DEVICE_HOST", "api.smiirl.com"), path: filepath.Join(dataDir, "number.json"), loc: loc, now: time.Now, changed: make(chan struct{})}
	var file struct {
		persisted
		Number *int `json:"number"` // files written before cells existed
	}
	b, err := os.ReadFile(s.path)
	switch {
	case errors.Is(err, os.ErrNotExist):
	case err != nil:
		return nil, err
	default:
		if err := json.Unmarshal(b, &file); err != nil {
			log.Printf("%s: %v; starting at 0", s.path, err)
			file.persisted, file.Number = persisted{}, nil
		}
	}
	if file.Cells == "" && file.Number != nil {
		file.Cells = numberToCells(clamp(*file.Number))
	}
	if !cellsRe.MatchString(file.Cells) {
		file.Cells = blankCells
	}
	if !atRe.MatchString(file.Daily.At) {
		file.Daily.At = defaultAt
	}
	if file.UpdatedAt.IsZero() {
		file.UpdatedAt = s.now()
	}
	if _, err := time.ParseInLocation(dayFormat, file.DaysDate, loc); err != nil {
		file.DaysDate = ""
	}
	if _, err := time.ParseInLocation(minFormat, file.CountdownAt, loc); err != nil {
		file.CountdownAt = ""
	}
	if !userRe.MatchString(file.GitHub.User) {
		file.GitHub = github{}
	}
	if file.GitHub.What != "prs" {
		file.GitHub.What = "commits"
	}
	if file.Cycle.Every < 1 || file.Cycle.Every > maxEvery {
		file.Cycle.Every = defaultEvery
	}
	file.Cycle.Modes = keepCyclable(file.persisted, file.Cycle.Modes)
	if !file.persisted.shows(file.Mode) {
		file.Mode = "number"
	}
	s.persisted = file.persisted
	s.lastSent = s.display(s.now())
	return s, nil
}

// clockCells is the local time as HHbMM: the striped flap separates hours
// and minutes. A 12-hour clock drops the leading zero to a blank flap, the
// way a wall clock leaves the tens digit off; there is no flap for am/pm.
func clockCells(now time.Time, loc *time.Location, twelve bool) string {
	if !twelve {
		return now.In(loc).Format("15b04")
	}
	c := now.In(loc).Format("3b04")
	return strings.Repeat("a", 5-len(c)) + c
}

// daysCells counts the whole calendar days between today (in loc) and date,
// clamped to the drums, with the label "until", "since" or "today". Both
// ends are taken as UTC midnights so a DST change never yields a 23-hour
// day.
func daysCells(now time.Time, loc *time.Location, date string) (int, string, error) {
	target, err := time.Parse(dayFormat, date)
	if err != nil {
		return 0, "", err
	}
	y, m, d := now.In(loc).Date()
	today := time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
	days := int(target.Sub(today) / (24 * time.Hour))
	switch {
	case days > 0:
		return clamp(days), "until", nil
	case days < 0:
		return clamp(-days), "since", nil
	}
	return 0, "today", nil
}

// countdownCells is the time left until at, as HHbMM with the striped flap
// between: 06b30 is six and a half hours out. It rests at 00b00 once the
// moment is past and stops at 99b59, the most the drums hold.
func countdownCells(now time.Time, loc *time.Location, at string) (string, int, error) {
	t, err := time.ParseInLocation(minFormat, at, loc)
	if err != nil {
		return "", 0, err
	}
	mins := max(0, min(int(t.Sub(now)/time.Minute), maxCountdown))
	return fmt.Sprintf("%02db%02d", mins/60, mins%60), mins, nil
}

// showing is the mode with the drums at now: the mode itself, or the member a
// cycle has reached. Caller holds s.mu.
func (s *server) showing(now time.Time) string {
	if s.persisted.Mode == "cycle" {
		return s.persisted.cycleMode(now)
	}
	return s.persisted.Mode
}

// display is what the drums should show at now. Caller holds s.mu.
func (s *server) display(now time.Time) string {
	return s.cells(s.showing(now), now)
}

// cells is what mode m shows at now. A mode whose setting has gone falls back
// to the stored number rather than to nothing. Caller holds s.mu.
func (s *server) cells(m string, now time.Time) string {
	p := s.persisted
	switch m {
	case "clock":
		return clockCells(now, s.loc, p.Clock12)
	case "date":
		return now.In(s.loc).Format("01b02")
	case "days":
		if n, _, err := daysCells(now, s.loc, p.DaysDate); err == nil {
			return numberToCells(n)
		}
	case "countdown":
		if c, _, err := countdownCells(now, s.loc, p.CountdownAt); err == nil {
			return c
		}
	case "github":
		if p.GitHub.User != "" && !p.GitHub.At.IsZero() {
			return numberToCells(clamp(p.GitHub.Count))
		}
	}
	return p.Cells
}

// modeView is the mode part of /api/state and the /api/mode reply. Caller
// holds s.mu.
func (s *server) modeView(now time.Time) map[string]any {
	p := s.persisted
	var days, label any
	if n, l, err := daysCells(now, s.loc, p.DaysDate); err == nil {
		days, label = n, l
	}
	var left any
	if _, m, err := countdownCells(now, s.loc, p.CountdownAt); err == nil {
		left = m
	}
	var fetched any
	if !p.GitHub.At.IsZero() {
		fetched = p.GitHub.At
	}
	return map[string]any{
		"mode":      p.Mode,
		"showing":   s.showing(now),
		"display":   s.display(now),
		"clock":     map[string]any{"cells": clockCells(now, s.loc, p.Clock12), "hour12": p.Clock12},
		"date":      map[string]any{"cells": s.cells("date", now)},
		"days":      map[string]any{"date": p.DaysDate, "days": days, "label": label},
		"countdown": map[string]any{"at": p.CountdownAt, "left": left},
		"github":    map[string]any{"user": p.GitHub.User, "what": p.GitHub.What, "count": p.GitHub.Count, "at": fetched, "error": errOrNil(p.GitHub.Err)},
		"cycle":     map[string]any{"modes": p.Cycle.Modes, "every": p.Cycle.Every},
	}
}

func errOrNil(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func clamp(n int) int {
	return max(0, min(n, maxNumber))
}

// numberToCells right-aligns n on the drums with leading blanks, the way the
// real counter shows short numbers.
func numberToCells(n int) string {
	d := strconv.Itoa(n)
	return strings.Repeat("a", 5-len(d)) + d
}

func cellsNumber(cells string) (int, bool) {
	if !numberRe.MatchString(cells) {
		return 0, false
	}
	n, _ := strconv.Atoi(strings.TrimLeft(cells, "a"))
	return n, true
}

func numberOrNil(cells string) any {
	if n, ok := cellsNumber(cells); ok {
		return n
	}
	return nil
}

// deviceValue is what the firmware gets: an int for a plain number, else the
// raw cells as a string, the way the cloud addresses blank and striped flaps.
func deviceValue(cells string) any {
	if n, ok := cellsNumber(cells); ok {
		return n
	}
	return cells
}

func cellsView(cells string) map[string]any {
	return map[string]any{"cells": cells, "number": numberOrNil(cells)}
}

// passed is the latest daily boundary at or before now.
func passed(now time.Time, loc *time.Location, at string) time.Time {
	hm, _ := time.Parse("15:04", at)
	now = now.In(loc)
	b := time.Date(now.Year(), now.Month(), now.Day(), hm.Hour(), hm.Minute(), 0, 0, loc)
	if now.Before(b) {
		b = b.AddDate(0, 0, -1)
	}
	return b
}

// dueDays counts the daily boundaries after d.Last that have passed by now,
// at most maxCatchUp, and returns the date the count runs up to. An empty
// Last owes today's boundary at most.
func dueDays(now time.Time, loc *time.Location, d daily) (int, string) {
	due := passed(now, loc, d.At)
	last, err := time.ParseInLocation(dayFormat, d.Last, loc)
	if err != nil {
		t := now.In(loc)
		last = time.Date(t.Year(), t.Month(), t.Day()-1, 0, 0, 0, 0, loc)
	}
	days := 0
	for day := last.AddDate(0, 0, 1); !day.After(due) && days < maxCatchUp; day = day.AddDate(0, 0, 1) {
		days++
	}
	return days, due.Format(dayFormat)
}

// tick applies the daily step for every boundary passed since Daily.Last.
func (s *server) tick() {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.persisted
	if p.Daily.Step == 0 {
		return
	}
	days, upTo := dueDays(s.now(), s.loc, p.Daily)
	if days == 0 {
		return
	}
	p.Daily.Last = upTo
	if n, ok := cellsNumber(p.Cells); ok {
		p.Cells = numberToCells(clamp(n + days*p.Daily.Step))
	} else {
		log.Printf("daily: %q is not a number, skipping %d day(s)", p.Cells, days)
	}
	if err := s.commit(p); err != nil {
		log.Printf("daily: %v", err)
	}
}

func (s *server) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1.0/register/{mac}", s.handleRegister)
	mux.HandleFunc("GET /v1.0/recover/{code}/{mac}", s.handleRecover)
	mux.HandleFunc("GET /v1.0/{mac}/{key}", s.handleBootstrap)
	mux.HandleFunc("POST /v1.0/{mac}/{key}/status", s.handleStatus)
	mux.HandleFunc("GET /{mac}/number", s.handleNumber)
	mux.HandleFunc("GET /api/state", s.handleState)
	mux.HandleFunc("PUT /api/number", s.handleSet)
	mux.HandleFunc("POST /api/number", s.handleSet)
	mux.HandleFunc("PUT /api/daily", s.handleDaily)
	mux.HandleFunc("POST /api/daily", s.handleDaily)
	mux.HandleFunc("PUT /api/mode", s.handleMode)
	mux.HandleFunc("POST /api/mode", s.handleMode)
	mux.HandleFunc("GET /manifest.webmanifest", asset("application/manifest+json", manifestJSON))
	mux.HandleFunc("GET /sw.js", asset("text/javascript; charset=utf-8", serviceWorkerJS))
	mux.HandleFunc("GET /icon.svg", asset("image/svg+xml", iconSVG))
	mux.HandleFunc("GET /icon.png", asset("image/png", iconPNG))
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintln(w, "ok")
	})
	mux.HandleFunc("GET /number", func(w http.ResponseWriter, _ *http.Request) {
		// The firmware's internet check after joining Wi-Fi; the cloud answers 1.
		writeJSON(w, http.StatusOK, map[string]int{"number": 1})
	})
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		if s.deviceHost(r) {
			writeJSON(w, http.StatusOK, map[string]string{"smiirl": "api"})
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(indexHTML)
	})
	// On the device's hostname, behave like the cloud: every other path is a
	// 200 {"api":"front"}, and the page's writable API is not offered at all.
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.deviceHost(r) {
			if _, pattern := mux.Handler(r); pattern == "" || strings.HasPrefix(r.URL.Path, "/api/") {
				writeJSON(w, http.StatusOK, map[string]string{"api": "front"})
				return
			}
		}
		mux.ServeHTTP(w, r)
	})
}

// deviceHost reports whether the request arrived on the name the firmware
// polls (SMIIRL_DEVICE_HOST, api.smiirl.com by default).
func (s *server) deviceHost(r *http.Request) bool {
	host := r.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	return host == s.devHost
}

func device(r *http.Request) (string, bool) {
	mac := r.PathValue("mac")
	return mac, macRe.MatchString(mac) && hexRe.MatchString(r.PathValue("key"))
}

func bootstrap(r *http.Request, mac string) map[string]any {
	return map[string]any{
		"result":    true,
		"v":         "smiirl_2.0.7-1",
		"attribute": "number",
		"url":       "http://" + r.Host + "/" + mac + "/number",
		"interval":  20,
		"code":      200,
	}
}

func (s *server) handleRegister(w http.ResponseWriter, r *http.Request) {
	if !macRe.MatchString(r.PathValue("mac")) {
		http.NotFound(w, r)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"result": true})
}

func (s *server) handleRecover(w http.ResponseWriter, r *http.Request) {
	mac := r.PathValue("mac")
	if !macRe.MatchString(mac) {
		http.NotFound(w, r)
		return
	}
	// Any hex token satisfies the key check on the routes that follow.
	writeJSON(w, http.StatusOK, map[string]any{"result": true, "recovery": true, "id": mac, "token": "0123456789ab"})
}

func (s *server) handleBootstrap(w http.ResponseWriter, r *http.Request) {
	mac, ok := device(r)
	if !ok {
		http.NotFound(w, r)
		return
	}
	writeJSON(w, http.StatusOK, bootstrap(r, mac))
}

func (s *server) handleStatus(w http.ResponseWriter, r *http.Request) {
	mac, ok := device(r)
	if !ok {
		http.NotFound(w, r)
		return
	}
	var status json.RawMessage
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&status); err == nil {
		s.mu.Lock()
		s.lastStatus = status
		s.mu.Unlock()
	}
	doc := bootstrap(r, mac)
	doc["status"] = true
	writeJSON(w, http.StatusOK, doc)
}

func (s *server) handleNumber(w http.ResponseWriter, r *http.Request) {
	if !macRe.MatchString(r.PathValue("mac")) {
		http.NotFound(w, r)
		return
	}
	s.mu.Lock()
	s.lastPoll = s.now()
	changed := s.changed
	stale := s.display(s.now()) != s.lastSent
	s.mu.Unlock()

	// A value set between polls is answered at once instead of after the hold.
	// The hold also ends when the clock or countdown moves on its own.
	if !stale {
		deadline := time.After(pollTimeout)
		tick := time.NewTicker(time.Second)
		defer tick.Stop()
	hold:
		for {
			select {
			case <-changed:
				break hold
			case <-deadline:
				break hold
			case <-r.Context().Done():
				return
			case <-tick.C:
				s.mu.Lock()
				moved := s.display(s.now()) != s.lastSent
				s.mu.Unlock()
				if moved {
					break hold
				}
			}
		}
	}
	s.mu.Lock()
	settle := time.Duration(0)
	if s.display(s.now()) != s.lastSent {
		settle = flapSettle - time.Since(s.lastSentAt)
	}
	s.mu.Unlock()
	if settle > 0 {
		select {
		case <-time.After(settle):
		case <-r.Context().Done():
			return
		}
	}
	s.mu.Lock()
	cells := s.display(s.now())
	if cells != s.lastSent {
		s.lastSentAt = time.Now()
	}
	s.lastSent = cells
	s.lastPoll = s.now() // the page treats a later lastPoll as "the counter got it"
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"number": deviceValue(cells)})
}

func (s *server) handleState(w http.ResponseWriter, _ *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var lastPoll any
	if !s.lastPoll.IsZero() {
		lastPoll = s.lastPoll
	}
	var lastStatus any
	if s.lastStatus != nil {
		lastStatus = s.lastStatus
	}
	v := cellsView(s.persisted.Cells)
	maps.Copy(v, s.modeView(s.now()))
	v["updatedAt"] = s.persisted.UpdatedAt
	v["daily"] = s.dailyView()
	v["device"] = map[string]any{
		"lastPoll":   lastPoll,
		"lastStatus": lastStatus,
		"online":     s.now().Sub(s.lastPoll) < time.Minute,
	}
	writeJSON(w, http.StatusOK, v)
}

// dailyView is the daily object of /api/state. Caller holds s.mu.
func (s *server) dailyView() map[string]any {
	d := s.persisted.Daily
	var next any
	if d.Step != 0 {
		n := passed(s.now(), s.loc, d.At).AddDate(0, 0, 1)
		// A day already recorded in Last never fires again (at moved later).
		if n.Format(dayFormat) <= d.Last {
			l, _ := time.ParseInLocation(dayFormat, d.Last, s.loc)
			hm, _ := time.Parse("15:04", d.At)
			n = time.Date(l.Year(), l.Month(), l.Day()+1, hm.Hour(), hm.Minute(), 0, 0, s.loc)
		}
		next = n
	}
	return map[string]any{"step": d.Step, "at": d.At, "next": next}
}

func (s *server) handleSet(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Number *int    `json:"number"`
		Cells  *string `json:"cells"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&body); err != nil || (body.Number == nil) == (body.Cells == nil) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": `body must be {"number":N} or {"cells":"xxxxx"}`})
		return
	}
	var cells string
	switch {
	case body.Cells != nil:
		if !cellsRe.MatchString(*body.Cells) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "cells must be five of 0-9, a (blank) or b (striped)"})
			return
		}
		cells = *body.Cells
	case *body.Number < 0 || *body.Number > maxNumber:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("number must be 0..%d", maxNumber)})
		return
	default:
		cells = numberToCells(*body.Number)
	}
	if err := s.set(cells); err != nil {
		log.Printf("persist %s: %v", cells, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not persist number"})
		return
	}
	writeJSON(w, http.StatusOK, cellsView(cells))
}

func (s *server) handleDaily(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Step *int    `json:"step"`
		At   *string `json:"at"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&body); err != nil || body.Step == nil || body.At == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": `body must be {"step":N,"at":"HH:MM"}`})
		return
	}
	if *body.Step < -maxNumber || *body.Step > maxNumber {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("step must be -%d..%d", maxNumber, maxNumber)})
		return
	}
	if !atRe.MatchString(*body.At) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "at must be HH:MM"})
		return
	}
	s.mu.Lock()
	p := s.persisted
	// Last starts at the boundary just passed so the first step lands at the
	// next one rather than retroactively; a day that already fired stays
	// recorded so moving at later never fires it twice.
	p.Daily = daily{Step: *body.Step, At: *body.At, Last: max(p.Daily.Last, passed(s.now(), s.loc, *body.At).Format(dayFormat))}
	err := s.commit(p)
	view := s.dailyView()
	s.mu.Unlock()
	if err != nil {
		log.Printf("persist daily: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not persist daily"})
		return
	}
	writeJSON(w, http.StatusOK, view)
}

func (s *server) handleMode(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Mode   string   `json:"mode"`
		Date   string   `json:"date"`   // days
		At     string   `json:"at"`     // countdown
		Hour12 *bool    `json:"hour12"` // clock
		User   string   `json:"user"`   // github
		What   string   `json:"what"`   // github
		Modes  []string `json:"modes"`  // cycle
		Every  *int     `json:"every"`  // cycle
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&body); err != nil {
		badMode(w, `body must be {"mode":"..."} with that mode's settings`)
		return
	}
	s.mu.Lock()
	p := s.persisted
	if body.Hour12 != nil {
		p.Clock12 = *body.Hour12
	}
	switch body.Mode {
	case "number", "clock", "date":
	case "days":
		if _, err := time.Parse(dayFormat, body.Date); err != nil {
			s.mu.Unlock()
			badMode(w, "date must be YYYY-MM-DD")
			return
		}
		p.DaysDate = body.Date
	case "countdown":
		if _, err := time.ParseInLocation(minFormat, body.At, s.loc); err != nil {
			s.mu.Unlock()
			badMode(w, "at must be YYYY-MM-DDTHH:MM")
			return
		}
		p.CountdownAt = body.At
	case "github":
		if !userRe.MatchString(body.User) {
			s.mu.Unlock()
			badMode(w, "user must be a GitHub login")
			return
		}
		if body.What != "commits" && body.What != "prs" {
			s.mu.Unlock()
			badMode(w, `what must be "commits" or "prs"`)
			return
		}
		// A different person or count starts over rather than showing the
		// number that belonged to the last one.
		if body.User != p.GitHub.User || body.What != p.GitHub.What {
			p.GitHub = github{User: body.User, What: body.What}
		}
	case "cycle":
		if body.Every != nil {
			if *body.Every < 1 || *body.Every > maxEvery {
				s.mu.Unlock()
				badMode(w, fmt.Sprintf("every must be 1..%d minutes", maxEvery))
				return
			}
			p.Cycle.Every = *body.Every
		}
		if body.Modes != nil {
			p.Cycle.Modes = keepCyclable(p, body.Modes)
		}
		if len(p.Cycle.Modes) < 2 {
			s.mu.Unlock()
			badMode(w, "modes must name at least two the counter can show")
			return
		}
	default:
		s.mu.Unlock()
		badMode(w, "mode must be one of "+strings.Join(modes, ", "))
		return
	}
	p.Mode = body.Mode
	// Dropping a setting a cycle was rotating to takes it out of the rotation.
	p.Cycle.Modes = keepCyclable(p, p.Cycle.Modes)
	err := s.commit(p)
	view := s.modeView(s.now())
	s.mu.Unlock()
	if err != nil {
		log.Printf("persist mode: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not persist mode"})
		return
	}
	if body.Mode == "github" {
		go s.refreshGitHub() // the drums should not wait for the next tick
	}
	writeJSON(w, http.StatusOK, view)
}

func badMode(w http.ResponseWriter, msg string) {
	writeJSON(w, http.StatusBadRequest, map[string]string{"error": msg})
}

// refreshGitHub fetches the count when a mode wants it and the last one has
// gone stale. The fetch runs without the lock; a failure leaves the number on
// the drums alone and is reported on the page.
func (s *server) refreshGitHub() {
	s.mu.Lock()
	p := s.persisted
	wanted := p.Mode == "github" || (p.Mode == "cycle" && slices.Contains(p.Cycle.Modes, "github"))
	stale := s.now().Sub(p.GitHub.At) >= githubEvery
	s.mu.Unlock()
	if p.GitHub.User == "" || !wanted || !stale {
		return
	}
	n, err := githubCount(p.GitHub.User, p.GitHub.What)

	s.mu.Lock()
	defer s.mu.Unlock()
	q := s.persisted
	if q.GitHub.User != p.GitHub.User || q.GitHub.What != p.GitHub.What {
		return // the page moved on while the fetch was out
	}
	if err != nil {
		log.Printf("github: %v", err)
		s.persisted.GitHub.Err = err.Error() // not persisted, so nothing to save
		return
	}
	q.GitHub.Count, q.GitHub.At, q.GitHub.Err = n, s.now(), ""
	if err := s.commit(q); err != nil {
		log.Printf("github: %v", err)
	}
}

func (s *server) set(cells string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if cells == s.persisted.Cells {
		return nil
	}
	p := s.persisted
	p.Cells = cells
	return s.commit(p)
}

// commit persists p and wakes a held device poll when what the drums show
// changed. Comparing the display rather than each setting means a new setting
// needs nothing added here. Caller holds s.mu.
func (s *server) commit(p persisted) error {
	prev := s.persisted
	moved := p.Cells != prev.Cells
	if moved {
		p.UpdatedAt = s.now()
	}
	was := s.display(s.now())
	s.persisted = p
	if err := s.save(); err != nil {
		s.persisted = prev
		return err
	}
	if now := s.display(s.now()); moved || now != was {
		close(s.changed)
		s.changed = make(chan struct{})
		log.Printf("cells %s -> %s, showing %s %s", prev.Cells, p.Cells, p.Mode, now)
	}
	return nil
}

// save writes number.json atomically: a temp file in the same directory, then
// a rename over the old one. Caller holds s.mu.
func (s *server) save() error {
	b, err := json.Marshal(s.persisted)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".number-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), s.path)
}

// writeJSON sends the body byte for byte as the cloud does: no trailing
// newline, an explicit length, the same content type. The firmware's
// internet check compares the reply literally; a 13-byte {"number":1}
// fails it.
func writeJSON(w http.ResponseWriter, status int, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Length", strconv.Itoa(len(b)))
	w.WriteHeader(status)
	w.Write(b)
}

// asset serves an embedded file. The page and its parts are rebuilt into the
// image, so they carry no cache lifetime of their own; the service worker is
// what keeps them around.
func asset(contentType string, body []byte) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Content-Length", strconv.Itoa(len(body)))
		w.Write(body)
	}
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	loc, err := time.LoadLocation(envOr("TZ", "Canada/Atlantic"))
	if err != nil {
		log.Fatal(err)
	}
	s, err := newServer(envOr("SMIIRL_DATA_DIR", "/data"), loc)
	if err != nil {
		log.Fatal(err)
	}
	s.tick()
	go s.refreshGitHub()
	go func() {
		for range time.Tick(30 * time.Second) {
			s.tick()
			s.refreshGitHub()
		}
	}()
	addr := ":" + envOr("PORT", "8080")
	srv := &http.Server{
		Addr:              addr,
		Handler:           s.handler(),
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      pollTimeout + flapSettle + 10*time.Second,
	}
	log.Printf("smiirl listening on %s, cells %s, mode %s, daily %+v in %s", addr, s.persisted.Cells, s.persisted.Mode, s.persisted.Daily, loc)
	log.Fatal(srv.ListenAndServe())
}
