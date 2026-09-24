package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// A var so tests can point it at a stub.
var githubAPI = "https://api.github.com"

// GitHub allows ten unauthenticated searches a minute, far above this rate.
var githubEvery = 5 * time.Minute

var githubClient = &http.Client{Timeout: 10 * time.Second}

// Both searches work unauthenticated, so no token is sent.
func githubCount(user, what string) (int, error) {
	path, q := "/search/commits", "author:"+user
	if what == "prs" {
		path, q = "/search/issues", "is:pr author:"+user
	}
	req, err := http.NewRequest(http.MethodGet, githubAPI+path+"?per_page=1&q="+url.QueryEscape(q), nil)
	if err != nil {
		return 0, err
	}
	// GitHub rejects a request with no User-Agent.
	req.Header.Set("User-Agent", "smiirl (github.com/jonpulsifer/infra)")
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := githubClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("%s: %s", path, resp.Status)
	}
	var body struct {
		Total int `json:"total_count"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&body); err != nil {
		return 0, err
	}
	return body.Total, nil
}
