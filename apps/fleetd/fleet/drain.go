package fleet

import (
	"context"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// DrainTimeout bounds how long a retirement waits for PodDisruptionBudgets
// to allow its evictions before it deletes the Node anyway. The machine is
// off and wiped by then, so its pods serve nothing, and deleting the Node
// has the cluster delete them.
const DrainTimeout = 10 * time.Minute

// DrainStartedAnnotation marks a retirement Workflow with the time its drain
// first met an eviction a PodDisruptionBudget refused, so the wait holds
// across a restart.
const DrainStartedAnnotation = "lolwtf.ca/drain-started-at"

type podRef struct{ Namespace, Name string }

// NodePods lists the pods a drain evicts from the node: every pod bound to
// it but a DaemonSet's, a static pod's mirror, and one already terminating,
// as kubectl drain leaves them.
func (c *Cluster) NodePods(ctx context.Context, node string) ([]podRef, error) {
	var list struct {
		Items []struct {
			Metadata struct {
				Name              string            `json:"name"`
				Namespace         string            `json:"namespace"`
				Annotations       map[string]string `json:"annotations"`
				DeletionTimestamp *string           `json:"deletionTimestamp"`
				OwnerReferences   []struct {
					Kind string `json:"kind"`
				} `json:"ownerReferences"`
			} `json:"metadata"`
		} `json:"items"`
	}
	q := url.Values{"fieldSelector": {"spec.nodeName=" + node}}
	if err := c.do(ctx, http.MethodGet, "/api/v1/pods?"+q.Encode(), "", nil, &list); err != nil {
		return nil, err
	}
	var pods []podRef
	for _, p := range list.Items {
		m := p.Metadata
		if _, mirror := m.Annotations["kubernetes.io/config.mirror"]; mirror || m.DeletionTimestamp != nil {
			continue
		}
		daemon := false
		for _, o := range m.OwnerReferences {
			daemon = daemon || o.Kind == "DaemonSet"
		}
		if !daemon {
			pods = append(pods, podRef{m.Namespace, m.Name})
		}
	}
	return pods, nil
}

// Evict asks the eviction API to delete the pod, which a PodDisruptionBudget
// may refuse with errEvictionBlocked. A pod already gone is no error.
func (c *Cluster) Evict(ctx context.Context, p podRef) error {
	body := map[string]any{
		"apiVersion": "policy/v1",
		"kind":       "Eviction",
		"metadata":   map[string]string{"name": p.Name, "namespace": p.Namespace},
	}
	err := c.do(ctx, http.MethodPost, "/api/v1/namespaces/"+url.PathEscape(p.Namespace)+"/pods/"+url.PathEscape(p.Name)+"/eviction", "application/json", body, nil)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	return err
}

// DeleteNode deletes the node's Node. The account's admission policy admits
// it only for a cordoned node that is no control plane. A Node already gone
// is no error.
func (c *Cluster) DeleteNode(ctx context.Context, node string) error {
	err := c.do(ctx, http.MethodDelete, "/api/v1/nodes/"+url.PathEscape(node), "", nil, nil)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	return err
}

// DeleteNodeCSRs deletes every CSR the node's kubelet made or that names the
// node, pending or issued, and says how many. Deleting an issued CSR revokes
// nothing: the cluster has no revocation for a kubelet's certificate.
func (c *Cluster) DeleteNodeCSRs(ctx context.Context, node string) (int, error) {
	const path = "/apis/certificates.k8s.io/v1/certificatesigningrequests"
	var list struct {
		Items []struct {
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
			Spec struct {
				Username string `json:"username"`
				Request  []byte `json:"request"`
			} `json:"spec"`
		} `json:"items"`
	}
	if err := c.do(ctx, http.MethodGet, path, "", nil, &list); err != nil {
		return 0, err
	}
	user := "system:node:" + node
	deleted := 0
	for _, csr := range list.Items {
		if csr.Spec.Username != user && csrSubject(csr.Spec.Request) != user {
			continue
		}
		err := c.do(ctx, http.MethodDelete, path+"/"+url.PathEscape(csr.Metadata.Name), "", nil, nil)
		if err != nil && !errors.Is(err, ErrNotFound) {
			return deleted, fmt.Errorf("delete CSR %s: %w", csr.Metadata.Name, err)
		}
		deleted++
	}
	return deleted, nil
}

// csrSubject is the CN a PEM certificate request asks for, or "".
func csrSubject(request []byte) string {
	block, _ := pem.Decode(request)
	if block == nil {
		return ""
	}
	req, err := x509.ParseCertificateRequest(block.Bytes)
	if err != nil {
		return ""
	}
	return req.Subject.CommonName
}

// RevokeJoinToken deletes the node's bootstrap token. A token already gone
// is no error.
func (c *Cluster) RevokeJoinToken(ctx context.Context, node string) error {
	err := c.do(ctx, http.MethodDelete, "/api/v1/namespaces/"+joinTokenNamespace+"/secrets/"+joinTokenSecretName(node), "", nil, nil)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	return err
}

// removeNode takes a node whose retirement wiped it out of the cluster:
// cordon, evict its pods, delete its Node, its CSRs and its bootstrap token.
// It says what it did for the journal, and whether it is done; a drain that
// waits on a PodDisruptionBudget is not, until DrainTimeout. Each step is
// idempotent, so a pass that fails at one tries them all again.
//
// A kubelet's client certificate cannot be revoked: a disk image from before
// the wipe still holds one, valid for up to a year, and its kubelet can
// register the Node again. What fleetd removes is everything the cluster
// lets it revoke.
func (r *Reconciler) removeNode(ctx context.Context, d Device, wf Object) (string, bool, error) {
	if r.Cluster == nil {
		return "fleetd has no credentials for the cluster's API, so delete its Node and its bootstrap token by hand", true, nil
	}
	if r.Config.IsControlPlane(d.Class) {
		return "a control plane's Node is the owner's to delete", true, nil
	}
	var did []string
	err := r.Cluster.Cordon(ctx, d.Name)
	switch {
	case errors.Is(err, ErrNotFound):
		did = append(did, "the cluster holds no Node for it")
	case err != nil:
		return "", false, fmt.Errorf("cordon: %w", err)
	default:
		waits, note, err := r.drain(ctx, d, wf)
		if err != nil || waits {
			return "", false, err
		}
		if err := r.Cluster.DeleteNode(ctx, d.Name); err != nil {
			return "", false, fmt.Errorf("delete the Node: %w", err)
		}
		did = append(did, "fleetd cordoned and drained it and deleted its Node"+note)
	}
	n, err := r.Cluster.DeleteNodeCSRs(ctx, d.Name)
	if err != nil {
		return "", false, fmt.Errorf("delete its CSRs: %w", err)
	}
	if err := r.Cluster.RevokeJoinToken(ctx, d.Name); err != nil {
		return "", false, fmt.Errorf("delete its bootstrap token: %w", err)
	}
	did = append(did, fmt.Sprintf("deleted %d CSRs of its kubelet and its bootstrap token", n))
	return strings.Join(did, "; "), true, nil
}

// drain evicts the node's pods and says whether it waits on a
// PodDisruptionBudget. Past DrainTimeout from the first refusal it waits no
// more, and the note names the pods it gave up on.
func (r *Reconciler) drain(ctx context.Context, d Device, wf Object) (bool, string, error) {
	pods, err := r.Cluster.NodePods(ctx, d.Name)
	if err != nil {
		return false, "", fmt.Errorf("list its pods: %w", err)
	}
	var blocked []string
	for _, p := range pods {
		err := r.Cluster.Evict(ctx, p)
		switch {
		case errors.Is(err, errEvictionBlocked):
			blocked = append(blocked, p.Namespace+"/"+p.Name)
		case err != nil:
			return false, "", fmt.Errorf("evict %s/%s: %w", p.Namespace, p.Name, err)
		}
	}
	if len(blocked) == 0 {
		return false, "", nil
	}
	started, err := time.Parse(time.RFC3339, wf.Annotations()[DrainStartedAnnotation])
	if err != nil {
		started = r.Now().UTC()
		err := r.Kube.Annotate(ctx, WorkflowResource, wf.Name(), map[string]string{DrainStartedAnnotation: started.Format(time.RFC3339)})
		if err != nil && !errors.Is(err, ErrNotFound) {
			return false, "", fmt.Errorf("mark the drain's start on %s: %w", wf.Name(), err)
		}
	}
	names := strings.Join(blocked, ", ")
	if r.Now().Sub(started) < DrainTimeout {
		why := fmt.Sprintf("fleetd: the retirement waits until %s for PodDisruptionBudgets to allow evicting %s from %s, then deletes the Node anyway", timestamp(started.Add(DrainTimeout)), names, d.Name)
		return true, "", r.journalOnce(ctx, "drain-waits/"+wf.Name(), d, "info", why)
	}
	return false, fmt.Sprintf(", which removes %s, whose eviction PodDisruptionBudgets refused for %s", names, DrainTimeout), nil
}
