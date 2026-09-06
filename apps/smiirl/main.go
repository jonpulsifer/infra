// smiirl stands in for api.smiirl.com so a Smiirl flip counter (firmware
// smiirl-2.0.7-1) runs without Smiirl's cloud. It answers the three routes the
// firmware polls over plain HTTP and exposes a small JSON API plus a web page
// for setting the number the counter shows.
package main

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"
)

//go:embed index.html
var indexHTML []byte

// pollTimeout bounds how long a firmware poll is held waiting for a change.
// The cloud holds ~17 s and the device re-polls ~20 s after the previous
// request started; 12 s leaves headroom for the round trip and stays under
// Envoy's 15 s default route timeout even where the HTTPRoute's own timeout
// is not honoured.
var pollTimeout = 12 * time.Second

const maxNumber = 99999 // the counter has five flaps

var (
	macRe = regexp.MustCompile(`^[0-9a-f]{12}$`)
	hexRe = regexp.MustCompile(`^[0-9a-f]+$`)
)

type persisted struct {
	Number    int       `json:"number"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type server struct {
	path string // number.json

	mu         sync.Mutex
	persisted  persisted
	lastPoll   time.Time
	lastSent   int // last number answered to the device; single device, so one is enough
	lastStatus json.RawMessage
	changed    chan struct{} // closed and replaced on every set
}

func newServer(dataDir string) (*server, error) {
	s := &server{path: filepath.Join(dataDir, "number.json"), changed: make(chan struct{})}
	b, err := os.ReadFile(s.path)
	switch {
	case errors.Is(err, os.ErrNotExist):
		s.persisted.UpdatedAt = time.Now()
	case err != nil:
		return nil, err
	default:
		if err := json.Unmarshal(b, &s.persisted); err != nil {
			log.Printf("%s: %v; starting at 0", s.path, err)
			s.persisted = persisted{UpdatedAt: time.Now()}
		}
	}
	return s, nil
}

func (s *server) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1.0/{mac}/{key}", s.handleBootstrap)
	mux.HandleFunc("POST /v1.0/{mac}/{key}/status", s.handleStatus)
	mux.HandleFunc("GET /{mac}/number", s.handleNumber)
	mux.HandleFunc("GET /api/state", s.handleState)
	mux.HandleFunc("PUT /api/number", s.handleSet)
	mux.HandleFunc("POST /api/number", s.handleSet)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintln(w, "ok")
	})
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(indexHTML)
	})
	return mux
}

func device(r *http.Request) (string, bool) {
	mac := r.PathValue("mac")
	return mac, macRe.MatchString(mac) && hexRe.MatchString(r.PathValue("key"))
}

func (s *server) handleBootstrap(w http.ResponseWriter, r *http.Request) {
	mac, ok := device(r)
	if !ok {
		http.NotFound(w, r)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"result":    true,
		"v":         "smiirl_2.0.7-1",
		"attribute": "number",
		"url":       "http://" + r.Host + "/" + mac + "/number",
		"interval":  20,
		"code":      200,
	})
}

func (s *server) handleStatus(w http.ResponseWriter, r *http.Request) {
	if _, ok := device(r); !ok {
		http.NotFound(w, r)
		return
	}
	var status json.RawMessage
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&status); err == nil {
		s.mu.Lock()
		s.lastStatus = status
		s.mu.Unlock()
	}
	writeJSON(w, http.StatusOK, map[string]bool{"result": true})
}

func (s *server) handleNumber(w http.ResponseWriter, r *http.Request) {
	if !macRe.MatchString(r.PathValue("mac")) {
		http.NotFound(w, r)
		return
	}
	s.mu.Lock()
	s.lastPoll = time.Now()
	changed := s.changed
	stale := s.persisted.Number != s.lastSent
	s.mu.Unlock()

	// A number set between polls is answered at once instead of after the hold.
	if !stale {
		select {
		case <-changed:
		case <-time.After(pollTimeout):
		case <-r.Context().Done():
			return
		}
	}
	s.mu.Lock()
	n := s.persisted.Number
	s.lastSent = n
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]int{"number": n})
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
	writeJSON(w, http.StatusOK, map[string]any{
		"number":    s.persisted.Number,
		"updatedAt": s.persisted.UpdatedAt,
		"device": map[string]any{
			"lastPoll":   lastPoll,
			"lastStatus": lastStatus,
			"online":     time.Since(s.lastPoll) < time.Minute,
		},
	})
}

func (s *server) handleSet(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Number *int `json:"number"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&body); err != nil || body.Number == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": `body must be {"number":N}`})
		return
	}
	n := *body.Number
	if n < 0 || n > maxNumber {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("number must be 0..%d", maxNumber)})
		return
	}
	if err := s.set(n); err != nil {
		log.Printf("persist %d: %v", n, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not persist number"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"number": n})
}

func (s *server) set(n int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if n == s.persisted.Number {
		return nil
	}
	prev := s.persisted
	s.persisted = persisted{Number: n, UpdatedAt: time.Now()}
	if err := s.save(); err != nil {
		s.persisted = prev
		return err
	}
	close(s.changed)
	s.changed = make(chan struct{})
	log.Printf("number %d -> %d", prev.Number, n)
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

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	s, err := newServer(envOr("SMIIRL_DATA_DIR", "/data"))
	if err != nil {
		log.Fatal(err)
	}
	addr := ":" + envOr("PORT", "8080")
	srv := &http.Server{
		Addr:              addr,
		Handler:           s.handler(),
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      pollTimeout + 10*time.Second,
	}
	log.Printf("smiirl listening on %s, number %d", addr, s.persisted.Number)
	log.Fatal(srv.ListenAndServe())
}
