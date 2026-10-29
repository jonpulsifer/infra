package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// autoApprover names the approver of an enrollment that attestation approved.
const autoApprover = "attestation"

// Verdict is the attest service's answer to GET /verdict/<serial>: the
// binding between the machine that attested and the request, by the UUID
// and node name the attestation recorded.
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

// AutoApproval approves a device request without a click when NetBox holds
// the machine as a staged worker with an unspent, recent attestation, the
// attest service's verdict binds that attestation to the request's UUID and
// the device's name, and the request claims the device's MAC. The
// attestation is spent in NetBox before the token is issued, so a failover
// or a second request cannot spend it again. Every fact in the request is the
// requester's own claim; the verdict's UUID is what the machine's TPM
// attested with.
type AutoApproval struct {
	Attest Attestor
	Dir    Directory
	// Window bounds how old an attestation may be, on top of the state key.
	Window time.Duration

	mu   sync.Mutex
	used map[string]time.Time
}

// claim spends the node's unspent attestation on this request, or says why
// the request needs a click. controlplane says whether the node's class is
// one, which never approves without a click.
func (a *AutoApproval) claim(ctx context.Context, d Device, n Node, controlplane bool, now time.Time) (time.Time, error) {
	if d.Serial == "" {
		return time.Time{}, errors.New("the request names no serial")
	}
	if n.Name == "" {
		return time.Time{}, errors.New("NetBox knows no device with its serial")
	}
	if n.Class == "" {
		return time.Time{}, fmt.Errorf("NetBox gives %s no class", n.Name)
	}
	if controlplane {
		return time.Time{}, fmt.Errorf("%s is a control plane, which is approved only by a click", n.Name)
	}
	if n.MAC == "" || !strings.EqualFold(n.MAC, d.MAC) {
		return time.Time{}, fmt.Errorf("its MAC is not %s's in NetBox", n.Name)
	}
	if ok, why := n.Attested(); !ok {
		return time.Time{}, errors.New(why)
	}
	switch age := now.Sub(n.LastAttested); {
	case age < -time.Minute:
		return time.Time{}, errors.New("its attestation is dated in the future")
	case age > a.Window:
		return time.Time{}, fmt.Errorf("it last attested %s ago, more than %s", age.Round(time.Second), a.Window)
	}

	vctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	v, err := a.Attest.Verdict(vctx, n.Serial)
	switch {
	case err != nil:
		return time.Time{}, fmt.Errorf("the attest service did not answer: %w", err)
	case v.Status != "attested":
		return time.Time{}, fmt.Errorf("the attest service reports it %s", v.Status)
	case v.Node == "" || v.Node != n.Name:
		return time.Time{}, fmt.Errorf("it attested as %q, not as %s", v.Node, n.Name)
	case v.UUID == "" || normUUID(v.UUID) != normUUID(d.UUID):
		return time.Time{}, fmt.Errorf("it attested with uuid %s, not the request's", v.UUID)
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	if a.used[n.Serial].Equal(n.LastAttested) {
		return time.Time{}, errors.New("its latest attestation already approved a request")
	}
	if a.used == nil {
		a.used = map[string]time.Time{}
	}
	a.used[n.Serial] = n.LastAttested
	return n.LastAttested, nil
}

// spend records the spend in NetBox, before any token exists. A write that
// fails leaves the attestation unspent there, and the caller refuses the
// approval and releases the reservation.
func (a *AutoApproval) spend(ctx context.Context, n Node, now time.Time) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := a.Dir.Spend(ctx, n, now); err != nil {
		return fmt.Errorf("NetBox did not record the spend: %w", err)
	}
	return nil
}

// release returns an attestation that approved nothing, such as when the
// config did not render or NetBox refused the spend.
func (a *AutoApproval) release(serial string, attestedAt time.Time) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.used[serial].Equal(attestedAt) {
		delete(a.used, serial)
	}
}
