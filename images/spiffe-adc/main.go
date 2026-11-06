// spiffe-adc is the executable behind an Application Default Credentials
// document whose credential_source is an executable. A Google client library
// runs it with GOOGLE_EXTERNAL_ACCOUNT_AUDIENCE set when it needs a subject
// token, about once an hour. It asks the node's SPIRE agent for a JWT-SVID for
// that audience and prints the reply the library expects. Nothing runs between
// two exchanges, so a pod needs no sidecar and no file to keep fresh.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/spiffe/go-spiffe/v2/svid/jwtsvid"
	"github.com/spiffe/go-spiffe/v2/workloadapi"
)

const (
	tokenTypeJWT     = "urn:ietf:params:oauth:token-type:jwt"
	tokenTypeIDToken = "urn:ietf:params:oauth:token-type:id_token"
	timeout          = 10 * time.Second
)

// response is the executable-sourced credential reply, version 1.
type response struct {
	Version    int    `json:"version"`
	Success    bool   `json:"success"`
	TokenType  string `json:"token_type,omitempty"`
	IDToken    string `json:"id_token,omitempty"`
	Expiration int64  `json:"expiration_time,omitempty"`
	Code       string `json:"code,omitempty"`
	Message    string `json:"message,omitempty"`
}

type fetcher func(ctx context.Context, audience string) (token string, expiry time.Time, err error)

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	if err := run(ctx, os.Getenv, fetchJWTSVID, os.Stdout); err != nil {
		os.Exit(1)
	}
}

// run answers one request. A failure is reported on stdout in the reply's own
// shape, so the library shows the message instead of a bare exit code.
func run(ctx context.Context, env func(string) string, fetch fetcher, stdout io.Writer) error {
	resp, err := answer(ctx, env, fetch)
	if err == nil {
		if out := env("GOOGLE_EXTERNAL_ACCOUNT_OUTPUT_FILE"); out != "" {
			err = writeFile(out, resp)
		}
	}
	if err != nil {
		resp = response{Version: 1, Success: false, Code: "spiffe-adc", Message: err.Error()}
	}
	if encErr := json.NewEncoder(stdout).Encode(resp); encErr != nil {
		return encErr
	}
	return err
}

func answer(ctx context.Context, env func(string) string, fetch fetcher) (response, error) {
	audience := env("GOOGLE_EXTERNAL_ACCOUNT_AUDIENCE")
	if audience == "" {
		return response{}, errors.New("GOOGLE_EXTERNAL_ACCOUNT_AUDIENCE is not set; the library sets it from the credential document")
	}
	tokenType := env("GOOGLE_EXTERNAL_ACCOUNT_TOKEN_TYPE")
	switch tokenType {
	case "":
		tokenType = tokenTypeJWT
	case tokenTypeJWT, tokenTypeIDToken:
	default:
		return response{}, fmt.Errorf("the credential document asks for %q; a JWT-SVID is %s", tokenType, tokenTypeJWT)
	}
	token, expiry, err := fetch(ctx, audience)
	if err != nil {
		return response{}, fmt.Errorf("fetch a JWT-SVID for %s: %w", audience, err)
	}
	return response{Version: 1, Success: true, TokenType: tokenType, IDToken: token, Expiration: expiry.Unix()}, nil
}

// fetchJWTSVID asks the Workload API at SPIFFE_ENDPOINT_SOCKET, go-spiffe's
// own variable, for a JWT-SVID with the one audience.
func fetchJWTSVID(ctx context.Context, audience string) (string, time.Time, error) {
	svid, err := workloadapi.FetchJWTSVID(ctx, jwtsvid.Params{Audience: audience})
	if err != nil {
		return "", time.Time{}, err
	}
	return svid.Marshal(), svid.Expiry, nil
}

// writeFile caches the reply where the library asked, readable by the
// workload's user only.
func writeFile(path string, resp response) error {
	b, err := json.Marshal(resp)
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o600)
}
