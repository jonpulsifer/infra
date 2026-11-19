// fleet-seed is a node image's first-boot unit: it reads the seed's address from the EFI system
// partition, fetches the seed from fleetd once, and stores it for the units that read it. The ESP
// file carries the seed URL, the install code and optionally the machine's UUID, and nothing else.
// fleetd burns the code on the first acknowledged read, so the retries cover only the network
// coming up; a 4xx answer is final. The ESP is only ever read.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const (
	seedVersion = 1
	// maxSeed caps a seed's size; a real one is a few kilobytes.
	maxSeed = 1 << 20
)

type espSeed struct {
	URL  string `json:"url"`
	UUID string `json:"uuid"`
	Code string `json:"code"`
}

type stored struct {
	Version int    `json:"version"`
	Name    string `json:"name"`
	Class   string `json:"class"`
	Profile string `json:"profile"`
}

type seeder struct {
	seedFile   string
	stateDir   string
	uuidFile   string
	retries    int
	retryDelay time.Duration
	timeout    time.Duration
	client     *http.Client
	setHost    func(string) error
	logf       func(string, ...any)
}

func main() {
	s := &seeder{
		client:  &http.Client{},
		setHost: func(name string) error { return syscall.Sethostname([]byte(name)) },
		logf:    log.Printf,
	}
	flag.StringVar(&s.seedFile, "seed-file", "/boot/fleet-seed.json", "the seed's address on the EFI system partition")
	flag.StringVar(&s.stateDir, "state-dir", "/var/lib/fleet", "where the stored seed goes")
	flag.StringVar(&s.uuidFile, "uuid-file", "/sys/class/dmi/id/product_uuid", "the machine's UUID")
	flag.IntVar(&s.retries, "retries", 10, "retries after a failed attempt, for the network coming up")
	flag.DurationVar(&s.retryDelay, "retry-delay", 6*time.Second, "the wait between attempts")
	flag.DurationVar(&s.timeout, "timeout", 60*time.Second, "the limit on one attempt")
	flag.Parse()
	log.SetFlags(0)
	if err := s.run(context.Background()); err != nil {
		log.Fatal(err)
	}
}

func (s *seeder) run(ctx context.Context) error {
	target := filepath.Join(s.stateDir, "seed.json")
	if _, err := os.Stat(target); err == nil {
		return nil
	}
	in, err := s.readESP()
	if err != nil {
		return err
	}
	raw, err := os.ReadFile(s.uuidFile)
	if err != nil {
		return err
	}
	uuid := strings.ToLower(strings.TrimSpace(string(raw)))
	if in.UUID != "" && strings.ToLower(in.UUID) != uuid {
		return fmt.Errorf("the seed on the ESP names %s, and this machine is %s", in.UUID, uuid)
	}
	body, err := s.fetch(ctx, in.URL, uuid, in.Code)
	if err != nil {
		return err
	}
	var seed stored
	if err := json.Unmarshal(body, &seed); err != nil || seed.Version != seedVersion || seed.Name == "" {
		return fmt.Errorf("the seed fleetd served is not a version %d seed with a name", seedVersion)
	}
	if err := writeAtomic(target, body); err != nil {
		return err
	}
	if err := s.setHost(seed.Name); err != nil {
		return fmt.Errorf("seed stored, but the hostname is not set: %w", err)
	}
	s.logf("seed stored for %s: class %s, profile %s", seed.Name, seed.Class, seed.Profile)
	return nil
}

func (s *seeder) readESP() (espSeed, error) {
	var in espSeed
	raw, err := os.ReadFile(s.seedFile)
	if err != nil {
		return in, fmt.Errorf("no %s on the EFI system partition: the install wrote no seed: %w", s.seedFile, err)
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&in); err != nil {
		return in, fmt.Errorf("%s: %w", s.seedFile, err)
	}
	if dec.More() {
		return in, fmt.Errorf("%s: trailing data after the seed", s.seedFile)
	}
	if in.URL == "" || in.Code == "" {
		return in, fmt.Errorf("%s: url and code are required", s.seedFile)
	}
	return in, nil
}

// fetch makes one acknowledged read the budget: only a transport failure or a 408, 429, 500, 502,
// 503 or 504 is tried again, and any other status ends the fetch.
func (s *seeder) fetch(ctx context.Context, raw, uuid, code string) ([]byte, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("the seed URL: %w", err)
	}
	q := u.Query()
	q.Set("uuid", uuid)
	q.Set("code", code)
	u.RawQuery = q.Encode()
	var last error
	for attempt := 0; attempt <= s.retries; attempt++ {
		if attempt > 0 {
			select {
			case <-time.After(s.retryDelay):
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		body, retry, err := s.attempt(ctx, u.String())
		if err == nil {
			return body, nil
		}
		if !retry {
			return nil, err
		}
		last = err
		s.logf("seed fetch attempt %d: %v", attempt+1, err)
	}
	return nil, fmt.Errorf("the seed was not fetched after %d attempts: %w", s.retries+1, last)
}

func (s *seeder) attempt(ctx context.Context, target string) ([]byte, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, false, err
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, true, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		switch resp.StatusCode {
		case 408, 429, 500, 502, 503, 504:
			return nil, true, fmt.Errorf("fleetd answered %s", resp.Status)
		}
		return nil, false, fmt.Errorf("fleetd answered %s; the seed is not served", resp.Status)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxSeed+1))
	switch {
	case err != nil:
		return nil, true, err
	case len(body) > maxSeed:
		return nil, false, errors.New("the seed is larger than 1 MiB")
	}
	return body, false, nil
}

// writeAtomic leaves either no file or the whole one, readable by its owner alone.
func writeAtomic(path string, b []byte) error {
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, "seed.*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		return err
	}
	if _, err := f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(f.Name(), path); err != nil {
		return err
	}
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
