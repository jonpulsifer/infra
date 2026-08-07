package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// githubClient is the port bosun talks to the GitHub Actions runner API
// through. ghClient is the real adapter; tests substitute a fake.
//
// There is deliberately no "list runners" method: GitHub's list accumulates
// unconsumed JIT registrations as ghosts, so it is never authoritative for
// pool size. Every call here addresses one runner by id.
type githubClient interface {
	// GenerateJITConfig mints a just-in-time runner registration. The
	// returned config expires ~1h from this call if never consumed, so
	// callers must mint it immediately before boot, never stockpile it.
	GenerateJITConfig(ctx context.Context, repo, name string, labels []string) (runnerID int64, encodedJITConfig string, err error)
	// GetRunner reports one runner's live status.
	GetRunner(ctx context.Context, repo string, runnerID int64) (status string, busy bool, err error)
	DeleteRunner(ctx context.Context, repo string, runnerID int64) error
}

const githubAPIBase = "https://api.github.com"

// ghClient is the real githubClient, talking to api.github.com. base is
// overridable so tests can point it at an httptest server.
type ghClient struct {
	httpClient *http.Client
	token      string
	base       string
}

func newGHClient(token string) *ghClient {
	return &ghClient{
		httpClient: &http.Client{Timeout: 30 * time.Second},
		token:      token,
		base:       githubAPIBase,
	}
}

func (c *ghClient) GenerateJITConfig(ctx context.Context, repo, name string, labels []string) (int64, string, error) {
	body := map[string]any{
		"name":            name,
		"runner_group_id": 1,
		"labels":          labels,
	}
	var resp struct {
		Runner struct {
			ID int64 `json:"id"`
		} `json:"runner"`
		EncodedJITConfig string `json:"encoded_jit_config"`
	}
	url := fmt.Sprintf("%s/repos/%s/actions/runners/generate-jitconfig", c.base, repo)
	if err := c.do(ctx, http.MethodPost, url, body, &resp); err != nil {
		return 0, "", err
	}
	return resp.Runner.ID, resp.EncodedJITConfig, nil
}

func (c *ghClient) GetRunner(ctx context.Context, repo string, runnerID int64) (string, bool, error) {
	var resp struct {
		Status string `json:"status"`
		Busy   bool   `json:"busy"`
	}
	url := fmt.Sprintf("%s/repos/%s/actions/runners/%d", c.base, repo, runnerID)
	if err := c.do(ctx, http.MethodGet, url, nil, &resp); err != nil {
		return "", false, err
	}
	return resp.Status, resp.Busy, nil
}

func (c *ghClient) DeleteRunner(ctx context.Context, repo string, runnerID int64) error {
	url := fmt.Sprintf("%s/repos/%s/actions/runners/%d", c.base, repo, runnerID)
	return c.do(ctx, http.MethodDelete, url, nil, nil)
}

func (c *ghClient) do(ctx context.Context, method, url string, body, out any) error {
	var reqBody io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reqBody = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, reqBody)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("github %s %s: %s: %s", method, url, resp.Status, bytes.TrimSpace(data))
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}
