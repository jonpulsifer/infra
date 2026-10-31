package fleet

import (
	"context"
	"crypto/x509"
	"encoding/asn1"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"
)

// KubeletClientSigner is the signer of a kubelet's client certificate.
const KubeletClientSigner = "kubernetes.io/kube-apiserver-client-kubelet"

// JoinTokenLinger is how long a node's bootstrap token outlives the approval
// of the certificate it asked for. The kubelet reads the issued certificate
// through the token within seconds of the signature, so the token is deleted
// on the first pass at least this long after the approval, once the
// certificate is issued.
const JoinTokenLinger = time.Minute

const csrPath = "/apis/certificates.k8s.io/v1/certificatesigningrequests"

var bootstrapUser = regexp.MustCompile(`^system:bootstrap:([a-z0-9]{6})$`)

type csrCondition struct {
	Type           string    `json:"type"`
	Status         string    `json:"status"`
	LastUpdateTime time.Time `json:"lastUpdateTime"`
}

// kubeletCSR is a kubelet client certificate request as the account lists
// it, with the object as the API server sent it for the approval's update.
type kubeletCSR struct {
	Metadata struct {
		Name              string    `json:"name"`
		CreationTimestamp time.Time `json:"creationTimestamp"`
	} `json:"metadata"`
	Spec struct {
		SignerName string   `json:"signerName"`
		Username   string   `json:"username"`
		Groups     []string `json:"groups"`
		Usages     []string `json:"usages"`
		Request    []byte   `json:"request"`
	} `json:"spec"`
	Status struct {
		Conditions  []csrCondition `json:"conditions"`
		Certificate []byte         `json:"certificate"`
	} `json:"status"`

	raw json.RawMessage
}

// condition is the CSR's condition of that type, if it has one.
func (c kubeletCSR) condition(kind string) (csrCondition, bool) {
	for _, cond := range c.Status.Conditions {
		if cond.Type == kind {
			return cond, true
		}
	}
	return csrCondition{}, false
}

// pending says the CSR is neither approved, denied nor failed.
func (c kubeletCSR) pending() bool {
	return len(c.Status.Conditions) == 0
}

// KubeletCSRs lists the kubelet client certificate requests.
func (c *Cluster) KubeletCSRs(ctx context.Context) ([]kubeletCSR, error) {
	var list struct {
		Items []json.RawMessage `json:"items"`
	}
	q := url.Values{"fieldSelector": {"spec.signerName=" + KubeletClientSigner}}
	if err := c.do(ctx, http.MethodGet, csrPath+"?"+q.Encode(), "", nil, &list); err != nil {
		return nil, err
	}
	out := make([]kubeletCSR, 0, len(list.Items))
	for _, raw := range list.Items {
		var csr kubeletCSR
		if err := json.Unmarshal(raw, &csr); err != nil {
			return nil, fmt.Errorf("decode a CSR: %w", err)
		}
		if csr.Spec.SignerName != KubeletClientSigner {
			continue
		}
		csr.raw = raw
		out = append(out, csr)
	}
	return out, nil
}

// ApproveCSR adds the Approved condition to the CSR as listed. A CSR that
// changed since is a conflict, for the next pass.
func (c *Cluster) ApproveCSR(ctx context.Context, csr kubeletCSR, message string, now time.Time) error {
	var obj map[string]any
	if err := json.Unmarshal(csr.raw, &obj); err != nil {
		return err
	}
	status, _ := obj["status"].(map[string]any)
	if status == nil {
		status = map[string]any{}
		obj["status"] = status
	}
	conditions, _ := status["conditions"].([]any)
	status["conditions"] = append(conditions, map[string]any{
		"type":           "Approved",
		"status":         "True",
		"reason":         "FleetdNodeToken",
		"message":        message,
		"lastUpdateTime": timestamp(now),
	})
	return c.do(ctx, http.MethodPut, csrPath+"/"+url.PathEscape(csr.Metadata.Name)+"/approval", "application/json", obj, nil)
}

// kubeletClientNode checks that a PEM request is a kubelet client
// certificate request and nothing more, as the controller manager's own
// check does: one request whose signature holds, whose subject is exactly
// CN=system:node:<name> and O=system:nodes, with no alternative name, for
// client authentication with at most a digital signature and key
// encipherment besides. It returns the node's name, or why not.
func kubeletClientNode(request []byte, usages []string) (string, string) {
	block, rest := pem.Decode(request)
	if block == nil || block.Type != "CERTIFICATE REQUEST" || len(strings.TrimSpace(string(rest))) != 0 {
		return "", "the request is not one PEM certificate request"
	}
	req, err := x509.ParseCertificateRequest(block.Bytes)
	if err != nil {
		return "", "the request does not parse: " + err.Error()
	}
	if err := req.CheckSignature(); err != nil {
		return "", "the request's signature does not hold: " + err.Error()
	}
	node, ok := strings.CutPrefix(req.Subject.CommonName, "system:node:")
	if !ok || node == "" {
		return "", fmt.Sprintf("the request's CN %q names no node", req.Subject.CommonName)
	}
	cn, o := asn1.ObjectIdentifier{2, 5, 4, 3}, asn1.ObjectIdentifier{2, 5, 4, 10}
	for _, n := range req.Subject.Names {
		if !n.Type.Equal(cn) && !n.Type.Equal(o) {
			return node, fmt.Sprintf("the request's subject has more than a CN and O=system:nodes: %s", req.Subject)
		}
	}
	if len(req.Subject.Names) != 2 || !slices.Equal(req.Subject.Organization, []string{"system:nodes"}) {
		return node, fmt.Sprintf("the request's subject is not exactly a CN and O=system:nodes: %s", req.Subject)
	}
	if len(req.DNSNames)+len(req.EmailAddresses)+len(req.IPAddresses)+len(req.URIs) > 0 {
		return node, "the request names alternative names"
	}
	if !slices.Contains(usages, "client auth") {
		return node, "the request is not for client authentication"
	}
	for _, u := range usages {
		if u != "client auth" && u != "digital signature" && u != "key encipherment" {
			return node, fmt.Sprintf("the request asks for the usage %q", u)
		}
	}
	return node, ""
}

// joinBinding says whether a kubelet client CSR is bound to the bootstrap
// token that asked for it. It returns the node the CSR names, and why it is
// not bound, or "". A CSR is bound when it is a kubelet client request for
// node X and nothing more, its requester is the bootstrap token whose ID is
// X's, in the group JoinGroup, X is a worker NetBox holds planned or
// active, and the ledger holds that token for X, unexpired, created no later
// than the CSR.
func (r *Reconciler) joinBinding(csr kubeletCSR, id string, devices map[string]Device, now time.Time) (string, string) {
	node, why := kubeletClientNode(csr.Spec.Request, csr.Spec.Usages)
	if why != "" {
		return node, why
	}
	if !slices.Contains(csr.Spec.Groups, JoinGroup) {
		return node, "its requester is not in " + JoinGroup
	}
	if JoinTokenID(node) != id {
		return node, fmt.Sprintf("bootstrap token %s is not the token fleetd mints for %s", id, node)
	}
	d, ok := devices[node]
	switch {
	case !ok:
		return node, "NetBox lists no node " + node
	case d.Status != "planned" && d.Status != "active":
		return node, fmt.Sprintf("%s is %s in NetBox", node, d.Status)
	case r.Config.IsControlPlane(d.Class):
		return node, node + " is a control plane, which joins with the cluster's token"
	}
	rec, ok, err := r.Cluster.Ledger.Get(node)
	switch {
	case err != nil:
		return node, "fleetd cannot read its record of the node's token: " + err.Error()
	case !ok || rec.ID != id || rec.Created.IsZero():
		return node, "fleetd holds no live bootstrap token of its own for " + node
	case !now.Before(rec.Expires) || !csr.Metadata.CreationTimestamp.Before(rec.Expires):
		return node, fmt.Sprintf("%s's bootstrap token expired at %s", node, timestamp(rec.Expires))
	case csr.Metadata.CreationTimestamp.Before(rec.Created):
		return node, fmt.Sprintf("the request is older than %s's newest bootstrap token, from %s", node, timestamp(rec.Created))
	}
	return node, ""
}

// approveJoins approves each pending kubelet client CSR that a fleetd
// bootstrap token asked for its own node, and deletes the token once its
// kubelet has the certificate, so each token joins one node once. The
// kube-controller-manager approves no first certificate on folly: the
// binding clusters/folly/tinkerbell-access/node-client-approval.yaml takes
// system:bootstrappers:nodes out of its approval. Any other bootstrap
// request is left pending and journaled on the device it names: a join with
// the cluster's token, as shale's or a control plane's, is the owner's to
// approve. A renewal, which a node asks for with its own certificate, is
// the controller manager's.
func (r *Reconciler) approveJoins(ctx context.Context, devices []Device) error {
	csrs, err := r.Cluster.KubeletCSRs(ctx)
	if err != nil {
		return fmt.Errorf("list kubelet CSRs: %w", err)
	}
	byName := make(map[string]Device, len(devices))
	for _, d := range devices {
		byName[d.Name] = d
	}
	now := r.Now()
	var errs []error
	for _, csr := range csrs {
		m := bootstrapUser.FindStringSubmatch(csr.Spec.Username)
		if m == nil {
			continue
		}
		name := csr.Metadata.Name
		node, why := r.joinBinding(csr, m[1], byName, now)
		d, known := byName[node]
		if !known {
			d = Device{Name: node}
		}
		approved, isApproved := csr.condition("Approved")
		switch {
		case csr.pending() && why == "":
			if err := r.Cluster.ApproveCSR(ctx, csr, "fleetd: "+node+"'s own bootstrap token asked for it", now); err != nil {
				errs = append(errs, fmt.Errorf("approve CSR %s: %w", name, err))
				continue
			}
			Audit("fleet.join", r.Config.Site, d, "", "approved CSR "+name)
			msg := fmt.Sprintf("fleetd: approved the kubelet client certificate request %s, which %s's own bootstrap token %s asked for; the token is deleted once the kubelet has the certificate", name, node, m[1])
			if err := r.journalOnce(ctx, "csr-approved/"+name, d, "info", msg); err != nil {
				errs = append(errs, err)
			}
		case csr.pending():
			if r.once("csr-pending/" + name) {
				Audit("fleet.join", r.Config.Site, d, "", "left CSR "+name+" pending: "+why)
				log.Printf("kubelet CSR %s from bootstrap token %s waits: %s", name, m[1], why)
			}
			if known {
				msg := fmt.Sprintf("fleetd: the kubelet client certificate request %s, from bootstrap token %s, waits: %s. A join with the cluster's bootstrap token, such as a control plane's or shale's, is approved by hand, and only for a join the owner started: kubectl certificate approve %s", name, m[1], why, name)
				if err := r.journalOnce(ctx, "csr-pending/"+name, d, "warning", msg); err != nil {
					errs = append(errs, err)
				}
			}
		case isApproved && why == "" && len(csr.Status.Certificate) > 0 && now.Sub(approved.LastUpdateTime) >= JoinTokenLinger:
			if err := r.Cluster.RevokeJoinToken(ctx, node); err != nil {
				errs = append(errs, fmt.Errorf("delete %s's spent bootstrap token: %w", node, err))
				continue
			}
			Audit("fleet.join", r.Config.Site, d, "", "spent: CSR "+name+" issued")
			msg := fmt.Sprintf("fleetd: deleted %s's bootstrap token %s: its kubelet has its client certificate from CSR %s", node, m[1], name)
			if err := r.journalOnce(ctx, "token-spent/"+name, d, "info", msg); err != nil {
				errs = append(errs, err)
			}
		}
	}
	return errors.Join(errs...)
}

// once says whether this is the first time the process sees the key, for
// a line that is not journaled.
func (r *Reconciler) once(key string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.reported == nil {
		r.reported = map[string]bool{}
	}
	if r.reported["log/"+key] {
		return false
	}
	r.reported["log/"+key] = true
	return true
}
