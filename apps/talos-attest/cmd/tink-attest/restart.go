package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

const serviceAccountDir = "/var/run/secrets/kubernetes.io/serviceaccount"

// kube is just enough of the Kubernetes API to delete the pods one selector
// picks on one node.
type kube struct {
	base   string
	token  string
	client *http.Client
}

// inCluster reaches the API server as the pod's ServiceAccount.
func inCluster() (*kube, error) {
	host, port := os.Getenv("KUBERNETES_SERVICE_HOST"), os.Getenv("KUBERNETES_SERVICE_PORT")
	if host == "" || port == "" {
		return nil, errors.New("not in a cluster: KUBERNETES_SERVICE_HOST is unset")
	}
	token, err := os.ReadFile(serviceAccountDir + "/token")
	if err != nil {
		return nil, err
	}
	ca, err := os.ReadFile(serviceAccountDir + "/ca.crt")
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(ca) {
		return nil, errors.New("no certificate in the ServiceAccount's ca.crt")
	}
	return &kube{
		base:  "https://" + net.JoinHostPort(host, port),
		token: strings.TrimSpace(string(token)),
		client: &http.Client{
			Timeout:   30 * time.Second,
			Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}},
		},
	}, nil
}

// restartPods deletes each pod in namespace that selector picks on node, so
// its controller makes it again. It answers the names it deleted.
func (k *kube) restartPods(ctx context.Context, namespace, selector, node string) ([]string, error) {
	q := url.Values{"labelSelector": {selector}, "fieldSelector": {"spec.nodeName=" + node}}
	var list struct {
		Items []struct {
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
		} `json:"items"`
	}
	if err := k.do(ctx, http.MethodGet, "/api/v1/namespaces/"+url.PathEscape(namespace)+"/pods?"+q.Encode(), &list); err != nil {
		return nil, fmt.Errorf("list pods: %w", err)
	}
	var deleted []string
	for _, p := range list.Items {
		if err := k.do(ctx, http.MethodDelete, "/api/v1/namespaces/"+url.PathEscape(namespace)+"/pods/"+url.PathEscape(p.Metadata.Name), nil); err != nil {
			return deleted, fmt.Errorf("delete pod %s: %w", p.Metadata.Name, err)
		}
		deleted = append(deleted, p.Metadata.Name)
	}
	return deleted, nil
}

func (k *kube) do(ctx context.Context, method, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, method, k.base+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+k.token)
	req.Header.Set("Accept", "application/json")
	resp, err := k.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("%s %s: %s: %s", method, path, resp.Status, strings.TrimSpace(string(body)))
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(body, out)
}
