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

// githubClient addresses one runner by id and has no list method: GitHub's list
// keeps unconsumed JIT registrations as ghosts.
type githubClient interface {
	// The config expires ~1h from this call if unconsumed, so mint just before boot.
	GenerateJITConfig(ctx context.Context, repo, name string, labels []string) (runnerID int64, encodedJITConfig string, err error)
	GetRunner(ctx context.Context, repo string, runnerID int64) (status string, busy bool, err error)
	DeleteRunner(ctx context.Context, repo string, runnerID int64) error
}

const githubAPIBase = "https://api.github.com"

type ghClient struct {
	httpClient *http.Client
	// Resolves the bearer for repo; production wires (*appAuth).Token.
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

// doRequest serves ghClient with an installation token and appAuth with the
// App's own JWT.
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

// A >=300 response; callers read statusCode to spot a 404.
type httpStatusError struct {
	method, url, status string
	statusCode          int
	body                []byte
}

func (e *httpStatusError) Error() string {
	return fmt.Sprintf("github %s %s: %s: %s", e.method, e.url, e.status, e.body)
}

// runnerGone treats a 404 from the DELETE itself as success. The method check
// matters: DeleteRunner's auth calls also 404 when the App is not installed.
func runnerGone(err error) bool {
	var se *httpStatusError
	return errors.As(err, &se) && se.statusCode == http.StatusNotFound && se.method == http.MethodDelete
}

// appAuth signs App JWTs by hand and caches one installation token per
// installation until near its ~1h expiry.
type appAuth struct {
	appID int64
	key   *rsa.PrivateKey // read once at construction; never logged

	httpClient *http.Client
	base       string           // overridable for tests
	now        func() time.Time // overridable for tests

	mu            sync.Mutex
	installations map[string]int64      // repo -> installation id
	tokens        map[int64]cachedToken // installation id -> cached token
}

type cachedToken struct {
	token     string
	expiresAt time.Time
}

const (
	jwtClockSkew = 60 * time.Second // iat is backdated for clock drift, as GitHub advises
	jwtLifetime  = 9 * time.Minute  // GitHub caps exp at 10 minutes from iat; a minute of margin

	// A cached token this close to its 1h expiry counts as stale, so none dies mid-call.
	tokenRefreshMargin = 5 * time.Minute
)

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

// GitHub emits PKCS#1 keys; PKCS#8 is accepted for keys re-exported elsewhere.
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

// Token returns an installation token for repo, cached until its refresh
// margin. Nothing here is logged.
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
			// The installation is gone (uninstalled or reinstalled under a new id), so
			// the next call re-resolves.
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

// Narrowed to Administration: write, the one permission bosun uses, so a stolen
// token can do only what bosun does.
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
