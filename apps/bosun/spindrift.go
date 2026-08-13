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
	"os"
	"path/filepath"
	"strings"
	"time"
)

// errDraining marks a claim spawn refused because a stop is in
// progress; runBuild posts nothing for it so the lease can recover the work.
var errDraining = errors.New("draining")

// spindriftClient is the port bosun talks to a Spindrift outbox through.
// Spindrift never dials in -- bosun is always the poller, the same shape as
// githubClient -- so there is one claim call and two calls scoped to the
// build it returned. sdClient is the real adapter; tests substitute a fake.
type spindriftClient interface {
	// ClaimBuild long-polls Spindrift for a build request in one of classes.
	// nil, nil means none arrived within the poll window; that is not an
	// error.
	ClaimBuild(ctx context.Context, classes []string) (*buildClaim, error)
	Heartbeat(ctx context.Context, id string) error
	PostResult(ctx context.Context, id string, res buildResult) error
}

// buildClaim is one build request handed to this bosun host. Request is
// opaque -- bosun never parses it, only writes it into the claimed skiff's
// share for the guest to read.
type buildClaim struct {
	ID      string          `json:"id"`
	Class   string          `json:"class"`
	Request json.RawMessage `json:"request"`
}

// buildResult is what bosun posts back once a build skiff halts.
type buildResult struct {
	Status string `json:"status"`
	Log    string `json:"log"`
	Detail string `json:"detail,omitempty"`
}

const (
	buildSucceeded = "SUCCEEDED"
	buildFailed    = "FAILED"

	// claimTimeout allows for Spindrift holding the request open server-side
	// for up to ~55s of long-polling, plus round-trip slack.
	claimTimeout = 70 * time.Second
	callTimeout  = 30 * time.Second

	buildHeartbeatInterval = 60 * time.Second

	// buildResultMaxLog caps the log bosun posts back. The tail is kept, not
	// the head, because a build's report marker line is written last.
	buildResultMaxLog = 1 << 20 // 1 MiB
)

// sdClient is the real spindriftClient, talking to a Spindrift instance's
// internal bosun API. base is overridable so tests can point it at an
// httptest server.
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

func (c *sdClient) Heartbeat(ctx context.Context, id string) error {
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	_, err := c.do(ctx, http.MethodPost, c.base+"/internal/bosun/requests/"+id+"/heartbeat", nil, nil)
	return err
}

func (c *sdClient) PostResult(ctx context.Context, id string, res buildResult) error {
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	_, err := c.do(ctx, http.MethodPost, c.base+"/internal/bosun/requests/"+id+"/result", res, nil)
	return err
}

// do sends one request and, for a body-bearing response, decodes it into
// out. The status code is always returned so ClaimBuild can tell a 204
// "nothing to claim" apart from a 200 without out ever being touched.
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

// buildLoop claims and runs one Spindrift build at a time until ctx is
// cancelled.
//
// ponytail: one build in flight per bosun host, not one per available warm
// slot. Pool capacity -- the same warm/persist machinery every other class
// already has -- is the real limiter on how many builds a host could serve
// at once, so this leaves spare capacity on the table on a host with more
// than one build class. It also keeps a bosun restart from ever stranding
// more than one build mid-heartbeat. A second lane is another goroutine
// calling this loop, if the capacity ever matters more than that.
func (p *pool) buildLoop(ctx context.Context, sd spindriftClient, classes []string, pollInterval time.Duration) {
	for ctx.Err() == nil {
		claim, err := sd.ClaimBuild(ctx, classes)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			p.stats.spindriftError()
			p.logger.Warn("claim build", "error", err)
			time.Sleep(pollInterval)
			continue
		}
		if claim == nil {
			time.Sleep(time.Second) // guard a tight 204 loop; the long-poll IS the wait
			continue
		}
		p.stats.buildClaimed()
		p.runBuild(ctx, sd, claim)
	}
}

// runBuild boots a skiff for claim, waits for it to halt while heartbeating
// Spindrift so the claim's lease does not expire mid-build, and posts the
// result composed from whatever the guest left in the skiff's diag share.
// It blocks until the skiff is gone regardless of ctx, so a build in
// progress at shutdown gets the same drain-then-kill treatment as a busy
// GitHub runner rather than being abandoned mid-heartbeat.
func (p *pool) runBuild(ctx context.Context, sd spindriftClient, claim *buildClaim) {
	logger := p.logger.With("build_id", claim.ID, "class", claim.Class)

	s, err := p.spawn(ctx, p.buildBerth(claim))
	if err != nil {
		if errors.Is(err, errDraining) {
			// Never attempted: stay silent so the claim's lease expires and
			// another host picks the request up. A FAILED post here would
			// close the Spindrift build permanently for work nobody ran.
			logger.Info("claim refused mid-drain; leaving it for lease expiry")
			return
		}
		res := buildResult{Status: buildFailed, Detail: fmt.Sprintf("failed to spawn a build skiff: %v", err)}
		p.stats.buildResult(res.Status)
		p.postBuildResult(ctx, sd, claim.ID, res, logger)
		return
	}

	heartbeat := time.NewTicker(buildHeartbeatInterval)
	defer heartbeat.Stop()
	for {
		select {
		case <-s.done:
			res := p.collectBuildResult(s, logger)
			p.stats.buildResult(res.Status)
			p.postBuildResult(ctx, sd, claim.ID, res, logger)
			return
		case <-heartbeat.C:
			if err := sd.Heartbeat(ctx, claim.ID); err != nil {
				logger.Warn("heartbeat", "error", err)
			}
		}
	}
}

// collectBuildResult reads whatever the guest left in s's diag share --
// retire keeps that directory on purpose, the same evidence a wedged GitHub
// skiff leaves behind -- and composes the result Spindrift gets. A missing
// status file means the guest never finished the handshake, which is
// reported as FAILED rather than left for Spindrift's lease to time out on.
func (p *pool) collectBuildResult(s *skiff, logger *slog.Logger) buildResult {
	logBytes, _ := os.ReadFile(filepath.Join(s.paths.diagDir, "result", "build.log"))
	logText := tailString(logBytes, buildResultMaxLog)

	statusRaw, err := os.ReadFile(filepath.Join(s.paths.diagDir, "result", "status"))
	if err != nil {
		reason := s.reason()
		detail := "skiff exited without writing a result"
		if reason != "" && reason != exitCompleted {
			detail = fmt.Sprintf("skiff exited without writing a result (%s)", reason)
		}
		logger.Warn("build result missing", "error", err, "exit_reason", reason)
		return buildResult{Status: buildFailed, Log: logText, Detail: detail}
	}

	status := strings.TrimSpace(string(statusRaw))
	if status != buildSucceeded && status != buildFailed {
		logger.Warn("build result status unrecognized", "status", status)
		return buildResult{Status: buildFailed, Log: logText, Detail: fmt.Sprintf("unrecognized result status %q", status)}
	}
	return buildResult{Status: status, Log: logText}
}

// tailString caps b at max bytes, keeping the end: a build's report marker
// line is written last, so a truncation must drop the head instead.
func tailString(b []byte, max int) string {
	if len(b) <= max {
		return string(b)
	}
	return string(b[len(b)-max:])
}

// postBuildResult posts a build's outcome with a few retries on a context
// that outlives ctx -- the same posture retire's own DeleteRunner takes, and
// for the same reason: a lost result strands a Spindrift build row until its
// lease expires, which is worth a little extra time after bosun has
// otherwise decided to move on.
func (p *pool) postBuildResult(ctx context.Context, sd spindriftClient, id string, res buildResult, logger *slog.Logger) {
	pctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Minute)
	defer cancel()
	const attempts = 3
	var err error
	for i := 0; i < attempts; i++ {
		if i > 0 {
			time.Sleep(5 * time.Second)
		}
		if err = sd.PostResult(pctx, id, res); err == nil {
			logger.Info("build result posted", "status", res.Status)
			return
		}
		logger.Warn("post build result", "attempt", i+1, "error", err)
	}
	logger.Error("build result not posted, giving up", "error", err)
}
