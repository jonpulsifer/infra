package main

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"sync"
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
	// token resolves the bearer for a call against repo. Production wires
	// (*appAuth).Token; tests use a fixed value.
	token func(ctx context.Context, repo string) (string, error)
	base  string
}

func newGHClient(auth *appAuth) *ghClient {
	return &ghClient{
		httpClient: &http.Client{Timeout: 30 * time.Second},
		token:      auth.Token,
		base:       githubAPIBase,
	}
}

func (c *ghClient) GenerateJITConfig(ctx context.Context, repo, name string, labels []string) (int64, string, error) {
	bearer, err := c.token(ctx, repo)
	if err != nil {
		return 0, "", fmt.Errorf("github auth: %w", err)
	}
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
	if err := doRequest(ctx, c.httpClient, http.MethodPost, url, bearer, body, &resp); err != nil {
		return 0, "", err
	}
	return resp.Runner.ID, resp.EncodedJITConfig, nil
}

func (c *ghClient) GetRunner(ctx context.Context, repo string, runnerID int64) (string, bool, error) {
	bearer, err := c.token(ctx, repo)
	if err != nil {
		return "", false, fmt.Errorf("github auth: %w", err)
	}
	var resp struct {
		Status string `json:"status"`
		Busy   bool   `json:"busy"`
	}
	url := fmt.Sprintf("%s/repos/%s/actions/runners/%d", c.base, repo, runnerID)
	if err := doRequest(ctx, c.httpClient, http.MethodGet, url, bearer, nil, &resp); err != nil {
		return "", false, err
	}
	return resp.Status, resp.Busy, nil
}

func (c *ghClient) DeleteRunner(ctx context.Context, repo string, runnerID int64) error {
	bearer, err := c.token(ctx, repo)
	if err != nil {
		return fmt.Errorf("github auth: %w", err)
	}
	url := fmt.Sprintf("%s/repos/%s/actions/runners/%d", c.base, repo, runnerID)
	return doRequest(ctx, c.httpClient, http.MethodDelete, url, bearer, nil, nil)
}

// doRequest is the one place an HTTP call against the GitHub API is made,
// shared by ghClient (bearer = an installation token) and appAuth itself
// (bearer = the App's own JWT, for the two endpoints that mint one).
func doRequest(ctx context.Context, client *http.Client, method, url, bearer string, body, out any) error {
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
	req.Header.Set("Authorization", "Bearer "+bearer)
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return &httpStatusError{method: method, url: url, status: resp.Status, statusCode: resp.StatusCode, body: bytes.TrimSpace(data)}
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// httpStatusError is a >=300 response from doRequest. Its statusCode is what
// appAuth checks to tell "installation gone" (404) from any other failure.
type httpStatusError struct {
	method, url, status string
	statusCode          int
	body                []byte
}

func (e *httpStatusError) Error() string {
	return fmt.Sprintf("github %s %s: %s: %s", e.method, e.url, e.status, e.body)
}

// runnerGone reports whether err is a DeleteRunner that found nothing to
// delete. A 404 is the outcome the call exists to produce, not a failure to
// reach GitHub — and the callers that keep a runner id around to retry a
// failed deregistration would otherwise keep this one forever.
//
// The method check is what makes this safe, not a detail. DeleteRunner's own
// auth chain 404s too — resolveInstallation GETs /repos/{repo}/installation
// and mintInstallationToken POSTs for a token, and DeleteRunner wraps both —
// so errors.As alone matches "this App is not installed on the repo" and reads
// it as "that runner is already gone". Deleting the runner id on the strength
// of a DELETE that never left the process is the exact failure the id is kept
// to prevent, and it would be silent.
func runnerGone(err error) bool {
	var se *httpStatusError
	return errors.As(err, &se) && se.statusCode == http.StatusNotFound && se.method == http.MethodDelete
}

// appAuth mints GitHub App installation tokens: it signs its own short-lived
// JWTs with the App's private key, resolves which installation owns a repo,
// and caches the resulting installation token against its ~1h expiry. Go
// stdlib only -- crypto/rsa signs the JWT by hand, so no JWT library earns
// its place.
//
// Ticket-13's mint-immediately-before-boot rule lives in pool.go and is
// untouched by this: it mints a JIT config, which is a distinct ~1h-lived
// credential from the installation token below. Two clocks, both satisfied
// by minting each at the moment it is needed rather than stockpiling either.
type appAuth struct {
	appID int64
	key   *rsa.PrivateKey // read from the key file once, at construction; never re-read or logged

	httpClient *http.Client
	base       string           // overridable so tests can point it at an httptest server
	now        func() time.Time // overridable so tests can control cache expiry deterministically

	mu            sync.Mutex
	installations map[string]int64      // repo -> installation id
	tokens        map[int64]cachedToken // installation id -> cached token
}

type cachedToken struct {
	token     string
	expiresAt time.Time
}

const (
	jwtClockSkew = 60 * time.Second // iat backdated per GitHub's own doc, to tolerate clock drift
	jwtLifetime  = 9 * time.Minute  // GitHub caps exp at 10 minutes from iat; a minute of margin

	// tokenRefreshMargin is how far ahead of an installation token's 1h
	// expiry a cached one is treated as stale, so a mint in flight never
	// races the token dying mid-use.
	tokenRefreshMargin = 5 * time.Minute
)

// newAppAuth reads and parses privateKeyFile once. The parsed key lives only
// in memory for the process lifetime; it is never re-read from disk and
// never logged.
func newAppAuth(appID int64, privateKeyFile string) (*appAuth, error) {
	key, err := loadPrivateKey(privateKeyFile)
	if err != nil {
		return nil, fmt.Errorf("github app private key: %w", err)
	}
	return &appAuth{
		appID:         appID,
		key:           key,
		httpClient:    &http.Client{Timeout: 30 * time.Second},
		base:          githubAPIBase,
		now:           time.Now,
		installations: map[string]int64{},
		tokens:        map[int64]cachedToken{},
	}, nil
}

// loadPrivateKey parses the App's PEM key. GitHub's key generator and the
// manifest-conversion endpoint both emit PKCS#1 ("BEGIN RSA PRIVATE KEY");
// PKCS#8 is accepted too so a key re-exported by other tooling still works.
func loadPrivateKey(path string) (*rsa.PrivateKey, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}
	block, _ := pem.Decode(data)
	if block == nil {
		return nil, fmt.Errorf("%s: no PEM block found", path)
	}
	if key, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return key, nil
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("%s: parsing private key: %w", path, err)
	}
	key, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("%s: private key is not RSA", path)
	}
	return key, nil
}

// signJWT signs an App JWT by hand: RS256 over base64url(header).base64url(claims).
func (a *appAuth) signJWT() (string, error) {
	now := a.now()
	header, err := json.Marshal(map[string]string{"alg": "RS256", "typ": "JWT"})
	if err != nil {
		return "", err
	}
	claims, err := json.Marshal(map[string]any{
		"iat": now.Add(-jwtClockSkew).Unix(),
		"exp": now.Add(jwtLifetime).Unix(),
		"iss": a.appID,
	})
	if err != nil {
		return "", err
	}
	signingInput := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(claims)
	hashed := sha256.Sum256([]byte(signingInput))
	sig, err := rsa.SignPKCS1v15(rand.Reader, a.key, crypto.SHA256, hashed[:])
	if err != nil {
		return "", fmt.Errorf("signing app jwt: %w", err)
	}
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(sig), nil
}

// Token returns a bearer suitable for repo: an installation token, minted
// (or reused, inside its refresh margin) against the installation that owns
// repo. Both the installation id and the token are cached in memory for the
// life of the process; nothing here is ever logged.
func (a *appAuth) Token(ctx context.Context, repo string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	instID, ok := a.installations[repo]
	if !ok {
		id, err := a.resolveInstallation(ctx, repo)
		if err != nil {
			return "", err
		}
		instID = id
		a.installations[repo] = instID
	}

	if tok, ok := a.tokens[instID]; ok && a.now().Before(tok.expiresAt.Add(-tokenRefreshMargin)) {
		return tok.token, nil
	}

	tok, err := a.mintInstallationToken(ctx, instID)
	if err != nil {
		var herr *httpStatusError
		if errors.As(err, &herr) && herr.statusCode == http.StatusNotFound {
			// The installation is gone -- app uninstalled, or reinstalled
			// under a new id. Drop the cache so the next call re-resolves
			// instead of retrying a dead id forever.
			delete(a.installations, repo)
			delete(a.tokens, instID)
		}
		return "", err
	}
	a.tokens[instID] = tok
	return tok.token, nil
}

func (a *appAuth) resolveInstallation(ctx context.Context, repo string) (int64, error) {
	jwt, err := a.signJWT()
	if err != nil {
		return 0, err
	}
	var resp struct {
		ID int64 `json:"id"`
	}
	url := fmt.Sprintf("%s/repos/%s/installation", a.base, repo)
	if err := doRequest(ctx, a.httpClient, http.MethodGet, url, jwt, nil, &resp); err != nil {
		return 0, fmt.Errorf("resolve installation for %s: %w", repo, err)
	}
	return resp.ID, nil
}

// mintInstallationToken narrows the mint to Administration:write -- the one
// permission GenerateJITConfig/GetRunner/DeleteRunner need -- even though
// the App's own grant may carry more, so a stolen token can do only what
// this process does.
func (a *appAuth) mintInstallationToken(ctx context.Context, instID int64) (cachedToken, error) {
	jwt, err := a.signJWT()
	if err != nil {
		return cachedToken{}, err
	}
	body := map[string]any{"permissions": map[string]string{"administration": "write"}}
	var resp struct {
		Token     string    `json:"token"`
		ExpiresAt time.Time `json:"expires_at"`
	}
	url := fmt.Sprintf("%s/app/installations/%d/access_tokens", a.base, instID)
	if err := doRequest(ctx, a.httpClient, http.MethodPost, url, jwt, body, &resp); err != nil {
		return cachedToken{}, fmt.Errorf("mint installation token: %w", err)
	}
	return cachedToken{token: resp.Token, expiresAt: resp.ExpiresAt}, nil
}
