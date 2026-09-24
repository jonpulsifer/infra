package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// VictoriaLogs on folly stores every pod's stdout. Vector ships each line
// tagged with the AccountID 1 tenant; a query with no header reads the empty
// tenant 0 and always sees zero hits.
var vlogsURL = envOr("SMIIRL_VICTORIALOGS_URL", "http://victoria-logs-server.monitoring.svc.cluster.local:9428")

const vlogsAccountID = "1"

// The shared dialplan event contract (docs/apps/pbx.md): a screened call logs
// one NOTICE line whose message contains this phrase. No other kind value
// starts with "screened", so the plain substring is unambiguous. Root console
// verbosity also echoes the Log() call itself as a `-- Executing [...]`
// verbose line carrying the same substituted args, so the exclusion is
// needed to keep the count at one hit per call, not two.
const screenedStream = `{namespace="pbx",container="asterisk"} "pbx-event kind=screened" -"Executing"`

// Cheap and in-cluster, so it can refresh far more often than the GitHub search.
var robocallsEvery = time.Minute

var vlogsClient = &http.Client{Timeout: 5 * time.Second}

// robocallsCount counts the calls the PBX screened from midnight in loc to now.
func robocallsCount(now time.Time, loc *time.Location) (int, error) {
	y, m, d := now.In(loc).Date()
	since := time.Date(y, m, d, 0, 0, 0, 0, loc)
	q := fmt.Sprintf("_time:[%s, now] %s | stats count() as hits", since.Format(time.RFC3339), screenedStream)

	req, err := http.NewRequest(http.MethodGet, vlogsURL+"/select/logsql/query?"+url.Values{"query": {q}}.Encode(), nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("AccountID", vlogsAccountID)
	resp, err := vlogsClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<12))
		return 0, fmt.Errorf("logsql: %s: %s", resp.Status, b)
	}
	// stats with no by() always answers with exactly one JSON line, even at
	// zero hits, and VictoriaLogs sends the count as a string.
	var body struct {
		Hits string `json:"hits"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&body); err != nil {
		return 0, err
	}
	return strconv.Atoi(body.Hits)
}
