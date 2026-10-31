package fleet

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// QuarantinedVerdict starts fleetd's attest_verdict for a node whose
// identity it revoked on a policy miss: "quarantined: <reason>". A control
// plane's failed-no-quarantine is not one.
const QuarantinedVerdict = "quarantined"

// Cluster is a client for the site's own Kubernetes API, as the account in
// clusters/folly/tinkerbell-access/fleet-controller-cordon.yaml: it cordons a
// quarantined node, creates each worker install's bootstrap token, and takes
// a retired node out of the cluster.
type Cluster struct {
	Server string
	Token  string
	Client *http.Client
}

// NewCluster reads the cluster's CA and the ServiceAccount's token.
func NewCluster(server, caFile, tokenFile string) (*Cluster, error) {
	ca, err := os.ReadFile(caFile)
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(ca) {
		return nil, fmt.Errorf("%s holds no certificate", caFile)
	}
	token, err := ReadSecret(tokenFile)
	if err != nil {
		return nil, err
	}
	if token == "" {
		return nil, fmt.Errorf("%s is empty", tokenFile)
	}
	return &Cluster{
		Server: strings.TrimSuffix(server, "/"),
		Token:  token,
		Client: &http.Client{
			Timeout:   15 * time.Second,
			Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}},
		},
	}, nil
}

// Cordon marks the node unschedulable, as kubectl cordon does. A node the
// cluster does not know is ErrNotFound.
func (c *Cluster) Cordon(ctx context.Context, node string) error {
	return c.do(ctx, http.MethodPatch, "/api/v1/nodes/"+url.PathEscape(node), "application/merge-patch+json", json.RawMessage(`{"spec":{"unschedulable":true}}`), nil)
}

// errEvictionBlocked is a 429 from an eviction: a PodDisruptionBudget does
// not allow it now.
var errEvictionBlocked = errors.New("429 Too Many Requests")

// do sends one request with the account's token. A 404 is ErrNotFound, a 409
// ErrConflict and a 429 errEvictionBlocked.
func (c *Cluster) do(ctx context.Context, method, path, contentType string, body, out any) error {
	var payload io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		payload = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.Server+path, payload)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := c.Client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		status := errors.New(resp.Status)
		switch resp.StatusCode {
		case http.StatusNotFound:
			return ErrNotFound
		case http.StatusConflict:
			status = ErrConflict
		case http.StatusTooManyRequests:
			status = errEvictionBlocked
		}
		return fmt.Errorf("%s %s: %w: %s", method, path, status, strings.TrimSpace(string(msg)))
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}

// cordonQuarantined cordons a node whose attest_verdict is a quarantine, on
// every pass while the verdict stands, so an uncordon by hand before the
// owner clears the verdict does not hold. fleetd never uncordons: the
// owner clears the verdict, then uncordons the node. A device the cluster
// has no node for is left alone. A control plane is never cordoned, whatever
// its verdict says: it serves the cluster's API, and fleetd only alerts
// on one.
func (r *Reconciler) cordonQuarantined(ctx context.Context, d Device) error {
	if !strings.HasPrefix(d.Verdict, QuarantinedVerdict) || r.Config.IsControlPlane(d.Class) {
		return nil
	}
	if r.Cluster == nil {
		return r.journalOnce(ctx, "cordon-off/"+d.Name, d, "warning", "fleetd: the node is quarantined, and fleetd has no credentials for the cluster's API; cordon it by hand")
	}
	err := r.Cluster.Cordon(ctx, d.Name)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("cordon: %w", err)
	}
	key := "cordoned/" + d.Name + "/" + d.Verdict
	r.mu.Lock()
	seen := r.reported[key]
	r.mu.Unlock()
	if !seen {
		Audit("fleet.cordon", r.Config.Site, d, "", d.Verdict)
	}
	return r.journalOnce(ctx, key, d, "danger", fmt.Sprintf("fleetd: cordoned the node; its attest_verdict is %q. Clear the verdict, then uncordon it", d.Verdict))
}
