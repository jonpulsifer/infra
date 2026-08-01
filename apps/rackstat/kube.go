package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

const (
	saTokenPath = "/var/run/secrets/kubernetes.io/serviceaccount/token"
	saCAPath    = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
)

type kubeClient struct {
	base   string
	token  string
	rootKS string // kustomization whose lastAppliedRevision represents "the repo"
	client *http.Client
}

// newKubeClient builds a raw REST client from the in-cluster service account
// mount; client-go would be a heavy dependency for two GETs.
func newKubeClient() (*kubeClient, error) {
	host, port := os.Getenv("KUBERNETES_SERVICE_HOST"), os.Getenv("KUBERNETES_SERVICE_PORT")
	if host == "" || port == "" {
		return nil, fmt.Errorf("not running in a cluster")
	}
	token, err := os.ReadFile(saTokenPath)
	if err != nil {
		return nil, err
	}
	caPEM, err := os.ReadFile(saCAPath)
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		return nil, fmt.Errorf("invalid service account CA")
	}
	return &kubeClient{
		base:   "https://" + net.JoinHostPort(host, port),
		token:  strings.TrimSpace(string(token)),
		rootKS: envOr("ROOT_KUSTOMIZATION", "apps"),
		client: &http.Client{
			Timeout: 10 * time.Second,
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{RootCAs: pool},
			},
		},
	}, nil
}

type fluxCondition struct {
	Type   string `json:"type"`
	Status string `json:"status"`
}

type fluxList struct {
	Items []struct {
		Metadata struct {
			Name      string `json:"name"`
			Namespace string `json:"namespace"`
		} `json:"metadata"`
		Status struct {
			LastAppliedRevision string          `json:"lastAppliedRevision"`
			Conditions          []fluxCondition `json:"conditions"`
		} `json:"status"`
	} `json:"items"`
}

func (k *kubeClient) collectFlux(ctx context.Context) (*GitOps, error) {
	ks, err := k.fluxGET(ctx, "/apis/kustomize.toolkit.fluxcd.io/v1/kustomizations")
	if err != nil {
		return nil, err
	}
	hr, err := k.fluxGET(ctx, "/apis/helm.toolkit.fluxcd.io/v2/helmreleases")
	if err != nil {
		return nil, err
	}

	g := &GitOps{KustomizationsTotal: len(ks.Items), HelmReleasesTotal: len(hr.Items)}
	for _, item := range ks.Items {
		if isReady(item.Status.Conditions) {
			g.KustomizationsReady++
		}
		if item.Metadata.Namespace == "flux-system" && item.Metadata.Name == k.rootKS {
			g.Revision = item.Status.LastAppliedRevision
		}
	}
	for _, item := range hr.Items {
		if isReady(item.Status.Conditions) {
			g.HelmReleasesReady++
		}
	}
	return g, nil
}

func isReady(conds []fluxCondition) bool {
	for _, c := range conds {
		if c.Type == "Ready" {
			return c.Status == "True"
		}
	}
	return false
}

func (k *kubeClient) fluxGET(ctx context.Context, path string) (*fluxList, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, k.base+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+k.token)
	resp, err := k.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("kube API %s: HTTP %d", path, resp.StatusCode)
	}
	var list fluxList
	if err := json.NewDecoder(resp.Body).Decode(&list); err != nil {
		return nil, fmt.Errorf("kube API %s: %w", path, err)
	}
	return &list, nil
}
