package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// githubAPI is the search host; the tests point it at a stub.
var githubAPI = "https://api.github.com"

// githubEvery is how long a count stands before it is fetched again. GitHub
// allows ten unauthenticated searches a minute, so this is nowhere near the
// limit even with the drums asking for a different person every cycle turn.
var githubEvery = 5 * time.Minute

var githubClient = &http.Client{Timeout: 10 * time.Second}

// githubCount is how many public commits or pull requests user has, taken
// from the search API's total_count. Both searches work unauthenticated.
func githubCount(user, what string) (int, error) {
	path, q := "/search/commits", "author:"+user
	if what == "prs" {
		path, q = "/search/issues", "is:pr author:"+user
	}
	req, err := http.NewRequest(http.MethodGet, githubAPI+path+"?per_page=1&q="+url.QueryEscape(q), nil)
	if err != nil {
		return 0, err
	}
	// GitHub rejects a request that does not name itself.
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
