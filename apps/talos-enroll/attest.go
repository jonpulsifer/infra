package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sync"
	"time"
)

// autoApprover names the approver of an enrollment that attestation approved.
const autoApprover = "attestation"

// Verdict is the attest service's answer to GET /verdict/<serial>. Node and
// UUID are optional; when the service sends them they must match.
type Verdict struct {
	Status     string    `json:"status"`
	AttestedAt time.Time `json:"attested_at"`
	Node       string    `json:"node,omitempty"`
	UUID       string    `json:"uuid,omitempty"`
}

// Attestor answers whether a machine passed attestation, by SMBIOS serial.
type Attestor interface {
	Verdict(ctx context.Context, serial string) (Verdict, error)
}

// AttestClient reads verdicts from the attest service.
type AttestClient struct {
	BaseURL string
	Client  *http.Client
}

func (a *AttestClient) Verdict(ctx context.Context, serial string) (Verdict, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.BaseURL+"/verdict/"+url.PathEscape(serial), nil)
	if err != nil {
		return Verdict{}, err
	}
	resp, err := a.Client.Do(req)
	if err != nil {
		return Verdict{}, err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusNotFound:
		return Verdict{Status: "unknown"}, nil
	default:
		return Verdict{}, fmt.Errorf("GET %s: %s", req.URL, resp.Status)
	}
	var v Verdict
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&v); err != nil {
		return Verdict{}, fmt.Errorf("decode the verdict: %w", err)
	}
	return v, nil
}

// AutoApproval approves a device request without a click when its machine
// passed attestation recently and claims its node's MAC. Every fact in the
// request is the requester's own claim, so the window is the exposure: within
// it, a host that knows the serial and MAC of a machine that just attested
// can claim that machine's config. One attestation approves one request.
type AutoApproval struct {
	Attest Attestor
	Window time.Duration

	mu   sync.Mutex
	used map[string]time.Time
}

// claim spends the machine's latest attestation on this request, or says why
// the request needs a click. node is the node whose MAC the request claims.
func (a *AutoApproval) claim(ctx context.Context, d Device, node string, now time.Time) (time.Time, error) {
	if d.Serial == "" {
		return time.Time{}, errors.New("the request names no serial")
	}
	if node == "" {
		return time.Time{}, errors.New("its MAC matches no node")
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	v, err := a.Attest.Verdict(ctx, d.Serial)
	switch {
	case err != nil:
		return time.Time{}, fmt.Errorf("the attest service did not answer: %w", err)
	case v.Status != "attested":
		return time.Time{}, fmt.Errorf("the attest service reports it %s", v.Status)
	case v.Node != "" && v.Node != node:
		return time.Time{}, fmt.Errorf("it attested as %s, but its MAC is %s's", v.Node, node)
	case v.UUID != "" && normUUID(v.UUID) != normUUID(d.UUID):
		return time.Time{}, fmt.Errorf("it attested with uuid %s", v.UUID)
	case v.AttestedAt.After(now.Add(time.Minute)):
		return time.Time{}, errors.New("its attestation is dated in the future")
	case now.Sub(v.AttestedAt) > a.Window:
		return time.Time{}, fmt.Errorf("it last attested %s ago, more than %s", now.Sub(v.AttestedAt).Round(time.Second), a.Window)
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.used[d.Serial].Equal(v.AttestedAt) {
		return time.Time{}, errors.New("its latest attestation already approved a request")
	}
	if a.used == nil {
		a.used = map[string]time.Time{}
	}
	a.used[d.Serial] = v.AttestedAt
	return v.AttestedAt, nil
}

// release returns an attestation that approved nothing, such as when the
// config did not render.
func (a *AutoApproval) release(serial string, attestedAt time.Time) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.used[serial].Equal(attestedAt) {
		delete(a.used, serial)
	}
}
