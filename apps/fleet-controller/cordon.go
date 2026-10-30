package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// QuarantinedVerdict starts talos-attest's attest_verdict for a node whose
// identity it revoked on a policy miss: "quarantined: <reason>". A control
// plane's failed-no-quarantine is not one.
const QuarantinedVerdict = "quarantined"

// Cluster is a client for the one call the controller makes to the site's
// own Kubernetes API: cordoning a quarantined node. Its ServiceAccount may
// patch nodes and do nothing else.
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
	token, err := readSecret(tokenFile)
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
	path := "/api/v1/nodes/" + url.PathEscape(node)
	req, err := http.NewRequestWithContext(ctx, http.MethodPatch, c.Server+path, bytes.NewReader([]byte(`{"spec":{"unschedulable":true}}`)))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Content-Type", "application/merge-patch+json")
	req.Header.Set("Accept", "application/json")
	resp, err := c.Client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return ErrNotFound
	}
	if resp.StatusCode/100 != 2 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("PATCH %s: %s: %s", path, resp.Status, strings.TrimSpace(string(msg)))
	}
	return nil
}

// cordonQuarantined cordons a node whose attest_verdict is a quarantine, on
// every pass while the verdict stands, so an uncordon by hand before the
// owner clears the verdict does not hold. The controller never uncordons: the
// owner clears the verdict, then uncordons the node. A device the cluster
// has no node for is left alone.
func (r *Reconciler) cordonQuarantined(ctx context.Context, d Device) error {
	if !strings.HasPrefix(d.Verdict, QuarantinedVerdict) {
		return nil
	}
	if r.Cluster == nil {
		return r.journalOnce(ctx, "cordon-off/"+d.Name, d, "warning", "fleet-controller: the node is quarantined, and the controller has no credentials for the cluster's API; cordon it by hand")
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
	return r.journalOnce(ctx, key, d, "danger", fmt.Sprintf("fleet-controller: cordoned the node; its attest_verdict is %q. Clear the verdict, then uncordon it", d.Verdict))
}
