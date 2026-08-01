package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// The queries the fleet module reads. Named so the test adapter can answer
// them by identity rather than by prefix-matching a string literal.
const (
	queryNodeUp    = `up{job="node-exporter"}`
	queryNodeTemp  = `max by (node, instance) (node_hwmon_temp_celsius)`
	queryNodeCPU   = `100 - avg by (node, instance) (rate(node_cpu_seconds_total{job="node-exporter",mode="idle"}[5m])) * 100`
	queryNodeMem   = `(1 - node_memory_MemAvailable_bytes{job="node-exporter"} / node_memory_MemTotal_bytes{job="node-exporter"}) * 100`
	queryNodeReady = `kube_node_status_condition{condition="Ready",status="true"}`
	// Watchdog and InfoInhibitor fire forever by design; they are noise here.
	queryAlerts     = `ALERTS{alertstate="firing",alertname!~"Watchdog|InfoInhibitor"}`
	queryCPUHistory = `100 * (1 - avg(rate(node_cpu_seconds_total{job="node-exporter",mode="idle"}[10m])))`
)

// promSample is one Prometheus series reduced to the labels and the value.
type promSample struct {
	Metric map[string]string
	Value  float64
}

// promSource is the port the fleet module reads through. Two adapters
// implement it: httpProm against a real Prometheus, and the canned source in
// the tests.
type promSource interface {
	Query(ctx context.Context, query string) ([]promSample, error)
	Range(ctx context.Context, query string, window, step time.Duration) ([]float64, error)
}

// httpProm talks to a Prometheus HTTP API.
type httpProm struct {
	base   string // no trailing slash
	client *http.Client
}

func (p *httpProm) Query(ctx context.Context, query string) ([]promSample, error) {
	body, err := p.get(ctx, "/api/v1/query", url.Values{"query": {query}})
	if err != nil {
		return nil, err
	}
	var resp struct {
		Status string `json:"status"`
		Data   struct {
			Result []struct {
				Metric map[string]string `json:"metric"`
				Value  [2]any            `json:"value"`
			} `json:"result"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("prometheus response: %w", err)
	}
	if resp.Status != "success" {
		return nil, fmt.Errorf("prometheus query %q: status %s", query, resp.Status)
	}
	samples := make([]promSample, 0, len(resp.Data.Result))
	for _, r := range resp.Data.Result {
		str, _ := r.Value[1].(string)
		v, err := strconv.ParseFloat(str, 64)
		if err != nil {
			continue
		}
		samples = append(samples, promSample{Metric: r.Metric, Value: v})
	}
	return samples, nil
}

// Range returns the values of the first series of a range query.
func (p *httpProm) Range(ctx context.Context, query string, window, step time.Duration) ([]float64, error) {
	end := time.Now()
	vals := url.Values{
		"query": {query},
		"start": {strconv.FormatInt(end.Add(-window).Unix(), 10)},
		"end":   {strconv.FormatInt(end.Unix(), 10)},
		"step":  {strconv.FormatInt(int64(step.Seconds()), 10)},
	}
	body, err := p.get(ctx, "/api/v1/query_range", vals)
	if err != nil {
		return nil, err
	}
	var resp struct {
		Status string `json:"status"`
		Data   struct {
			Result []struct {
				Values [][2]any `json:"values"`
			} `json:"result"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("prometheus response: %w", err)
	}
	if resp.Status != "success" || len(resp.Data.Result) == 0 {
		return nil, fmt.Errorf("prometheus range query %q: no data", query)
	}
	var out []float64
	for _, v := range resp.Data.Result[0].Values {
		str, _ := v[1].(string)
		f, err := strconv.ParseFloat(str, 64)
		if err != nil {
			continue
		}
		out = append(out, round1(f))
	}
	return out, nil
}

const promMaxBody = 8 << 20

func (p *httpProm) get(ctx context.Context, path string, vals url.Values) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.base+path+"?"+vals.Encode(), nil)
	if err != nil {
		return nil, err
	}
	resp, err := p.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("prometheus %s: HTTP %d", path, resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, promMaxBody+1))
	if err != nil {
		return nil, fmt.Errorf("prometheus %s: %w", path, err)
	}
	if len(body) > promMaxBody {
		return nil, fmt.Errorf("prometheus %s: response too large", path)
	}
	return body, nil
}
