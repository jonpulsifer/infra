package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// errDraining is a spawn refused mid-stop. runBuild posts nothing, so the lease
// expires and another host can take the request.
var errDraining = errors.New("draining")

// errClaimLost is a refused heartbeat: the request was cancelled or reclaimed
// after its lease lapsed, so the guest's work is unwanted.
var errClaimLost = errors.New("build request no longer claimed by this host")

// spindriftClient is the build outbox API. bosun always polls; the server never
// dials in.
type spindriftClient interface {
	// ClaimBuild long-polls for a request in one of classes; nil, nil means none
	// arrived in the poll window.
	ClaimBuild(ctx context.Context, classes []string) (*buildClaim, error)
	Heartbeat(ctx context.Context, id, claimant string) error
	PostResult(ctx context.Context, id, claimant string, res buildResult) error
}

// Request is opaque to bosun, which writes it to the skiff's share for the guest.
type buildClaim struct {
	ID    string `json:"id"`
	Class string `json:"class"`
	// Claimant is the claim's fencing token, sent on every later call. A server
	// that mints none leaves it empty, and then nothing is sent.
	Claimant string          `json:"claimant"`
	Request  json.RawMessage `json:"request"`
}

type buildResult struct {
	Status string `json:"status"`
	Log    string `json:"log"`
	Detail string `json:"detail,omitempty"`
}

const (
	buildSucceeded = "SUCCEEDED"
	buildFailed    = "FAILED"

	// The server holds a claim open for up to ~55s, plus round-trip slack.
	claimTimeout = 70 * time.Second
	callTimeout  = 30 * time.Second

	buildHeartbeatInterval = 60 * time.Second

	// Keeps the tail, since a build's report marker line is written last.
	buildResultMaxLog = 1 << 20 // 1 MiB
)

// sdClient calls the internal bosun API over HTTP.
type sdClient struct {
	httpClient *http.Client
	token      string
	base       string
}

func newSDClient(url, token string) *sdClient {
	return &sdClient{
		httpClient: &http.Client{},
		token:      token,
		base:       strings.TrimSuffix(url, "/"),
	}
}

func (c *sdClient) ClaimBuild(ctx context.Context, classes []string) (*buildClaim, error) {
	ctx, cancel := context.WithTimeout(ctx, claimTimeout)
	defer cancel()
	var claim buildClaim
	status, err := c.do(ctx, http.MethodPost, c.base+"/internal/bosun/claim", map[string]any{"classes": classes}, &claim)
	if err != nil {
		return nil, err
	}
	if status == http.StatusNoContent {
		return nil, nil
	}
	return &claim, nil
}

func (c *sdClient) Heartbeat(ctx context.Context, id, claimant string) error {
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	status, err := c.do(ctx, http.MethodPost, c.base+"/internal/bosun/requests/"+id+"/heartbeat"+claimantQuery(claimant), nil, nil)
	if status == http.StatusNotFound {
		// 404 is the one answer for a request this claimant does not hold; every
		// other failure is the network's.
		return fmt.Errorf("%w: %v", errClaimLost, err)
	}
	return err
}

func (c *sdClient) PostResult(ctx context.Context, id, claimant string, res buildResult) error {
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	_, err := c.do(ctx, http.MethodPost, c.base+"/internal/bosun/requests/"+id+"/result"+claimantQuery(claimant), res, nil)
	return err
}

// A query parameter, since the result body's schema is strict and a heartbeat
// has no body. Empty sends nothing, for a server that mints no claimant.
func claimantQuery(claimant string) string {
	if claimant == "" {
		return ""
	}
	return "?claimant=" + url.QueryEscape(claimant)
}

// do returns the status even with no body, so ClaimBuild can tell 204 from 200.
func (c *sdClient) do(ctx context.Context, method, url string, body, out any) (status int, err error) {
	var reqBody io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return 0, err
		}
		reqBody = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, reqBody)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return resp.StatusCode, fmt.Errorf("spindrift %s %s: %s: %s", method, url, resp.Status, bytes.TrimSpace(data))
	}
	if out != nil && resp.StatusCode != http.StatusNoContent {
		return resp.StatusCode, json.NewDecoder(resp.Body).Decode(out)
	}
	return resp.StatusCode, nil
}

// buildSource claims build requests, runs each on a skiff and posts back what
// the guest left. spawn must keep p.spawn's errDraining contract.
type buildSource struct {
	sd     spindriftClient
	spawn  func(ctx context.Context, claim *buildClaim) (*skiff, error)
	logger *slog.Logger
	stats  *metrics
	// Zero means buildHeartbeatInterval.
	heartbeatEvery time.Duration
}

// buildLoop runs one claimed build at a time until ctx is cancelled.
// ponytail: one build per host; a second lane is another goroutine.
func (b *buildSource) buildLoop(ctx context.Context, classes []string, pollInterval time.Duration) {
	for ctx.Err() == nil {
		claim, err := b.sd.ClaimBuild(ctx, classes)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			b.stats.spindriftError()
			b.logger.Warn("claim build", "error", err)
			time.Sleep(pollInterval)
			continue
		}
		if claim == nil {
			time.Sleep(time.Second) // guards a tight 204 loop; the long-poll is the wait
			continue
		}
		b.stats.buildClaimed()
		b.runBuild(ctx, claim)
	}
}

// runBuild spawns a skiff, heartbeats to hold the lease until it halts, then
// posts its result. It waits for the skiff regardless of ctx, so a build
// drains like a busy runner.
func (b *buildSource) runBuild(ctx context.Context, claim *buildClaim) {
	logger := b.logger.With("build_id", claim.ID, "class", claim.Class)

	s, err := b.spawn(ctx, claim)
	if err != nil {
		if errors.Is(err, errDraining) {
			// Never attempted: a FAILED post would close the request for good,
			// so leave it for lease expiry and another host.
			logger.Info("claim refused mid-drain; leaving it for lease expiry")
			return
		}
		res := buildResult{Status: buildFailed, Detail: fmt.Sprintf("failed to spawn a build skiff: %v", err)}
		b.stats.buildResult(res.Status)
		b.postBuildResult(ctx, claim, res, logger)
		return
	}

	interval := b.heartbeatEvery
	if interval == 0 {
		interval = buildHeartbeatInterval
	}
	heartbeat := time.NewTicker(interval)
	defer heartbeat.Stop()
	lost := false
	for {
		select {
		case <-s.done:
			if lost {
				logger.Info("build skiff stopped after its claim was lost; no result to post")
				return
			}
			res := readBuildResult(s.paths.diagDir, s.reason(), logger)
			b.stats.buildResult(res.Status)
			b.postBuildResult(ctx, claim, res, logger)
			return
		case <-heartbeat.C:
			err := b.sd.Heartbeat(ctx, claim.ID, claim.Claimant)
			switch {
			case err == nil:
			// The server cancels a build by refusing its heartbeat. Kill the skiff
			// and post nothing, since a result would be refused too.
			case errors.Is(err, errClaimLost):
				if !lost {
					lost = true
					logger.Info("claim lost, killing build skiff", "error", err)
					s.condemn(exitCancelled)
					killBestEffort(s.ch, logger, "cancelled build cloud-hypervisor")
				}
			default:
				logger.Warn("heartbeat", "error", err)
			}
		}
	}
}

func tailString(b []byte, max int) string {
	if len(b) <= max {
		return string(b)
	}
	return string(b[len(b)-max:])
}

// postBuildResult retries on a context that outlives ctx: a lost result strands
// the request until its lease expires.
func (b *buildSource) postBuildResult(ctx context.Context, claim *buildClaim, res buildResult, logger *slog.Logger) {
	pctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Minute)
	defer cancel()
	const attempts = 3
	var err error
	for i := 0; i < attempts; i++ {
		if i > 0 {
			time.Sleep(5 * time.Second)
		}
		if err = b.sd.PostResult(pctx, claim.ID, claim.Claimant, res); err == nil {
			logger.Info("build result posted", "status", res.Status)
			return
		}
		logger.Warn("post build result", "attempt", i+1, "error", err)
	}
	logger.Error("build result not posted, giving up", "error", err)
}
