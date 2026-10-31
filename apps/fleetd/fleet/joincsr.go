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

// requestShape checks what a CSR asks for and who asked, before any
// binding: a kubelet client request for one node, from a requester in
// JoinGroup. It returns the node, and why not, or "".
func requestShape(csr kubeletCSR) (string, string) {
	node, why := kubeletClientNode(csr.Spec.Request, csr.Spec.Usages)
	if why == "" && !slices.Contains(csr.Spec.Groups, JoinGroup) {
		why = "its requester is not in " + JoinGroup
	}
	return node, why
}

// joinBinding says whether a kubelet client CSR is bound to the bootstrap
// token that asked for it. It returns the node the CSR names, and why it is
// not bound, or "". A CSR is bound when it is a kubelet client request for
// node X and nothing more, its requester is the bootstrap token whose ID is
// X's, in the group JoinGroup, X is a worker NetBox holds planned or
// active, and the ledger holds that token for X, unexpired, created no later
// than the CSR, and spent on no other CSR.
func (r *Reconciler) joinBinding(csr kubeletCSR, id string, devices map[string]Device, now time.Time) (string, string) {
	node, why := requestShape(csr)
	if why != "" {
		return node, why
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
	case rec.Approved != "" && rec.Approved != csr.Metadata.Name:
		return node, fmt.Sprintf("%s's bootstrap token is spent: fleetd approved CSR %s with it", node, rec.Approved)
	}
	return node, ""
}

// tokenOwner is the NetBox node whose fleetd bootstrap token has this ID, or
// "" for a token fleetd does not mint, such as the cluster's.
func tokenOwner(id string, devices []Device) string {
	for _, d := range devices {
		if JoinTokenID(d.Name) == id {
			return d.Name
		}
	}
	return ""
}

// approveJoins approves each pending kubelet client CSR that a fleetd
// bootstrap token asked for its own node, and deletes the token once its
// kubelet has the certificate, so each token joins one node once. The
// controller manager approves no request a bootstrap token makes on folly:
// clusters/folly/tinkerbell-access/node-client-approval.yaml takes
// system:bootstrappers:nodes out of its approval and refuses its account the
// approval. Any other bootstrap request is left pending and journaled on the
// devices it names. Only a request from a token fleetd does not mint, such as
// the cluster's for shale's or a control plane's join, gets the command that
// approves it; a fleetd token that asks for another node's name, or past its
// one use, is refused. A renewal, which a node asks for with its own
// certificate, is the controller manager's.
func (r *Reconciler) approveJoins(ctx context.Context, csrs []kubeletCSR, devices []Device) error {
	byName := make(map[string]Device, len(devices))
	for _, d := range devices {
		byName[d.Name] = d
	}
	now := r.Now()
	live := map[string]bool{}
	var errs []error
	for _, csr := range csrs {
		m := bootstrapUser.FindStringSubmatch(csr.Spec.Username)
		if m == nil {
			continue
		}
		name, id := csr.Metadata.Name, m[1]
		live[name] = true
		node, why := r.joinBinding(csr, id, byName, now)
		d, known := byName[node]
		if !known {
			d = Device{Name: node}
		}
		approved, isApproved := csr.condition("Approved")
		switch {
		case csr.pending() && why == "":
			if err := r.Cluster.Ledger.MarkApproved(node, name); err != nil {
				errs = append(errs, fmt.Errorf("record the approval of CSR %s: %w", name, err))
				continue
			}
			if err := r.Cluster.ApproveCSR(ctx, csr, "fleetd: "+node+"'s own bootstrap token asked for it", now); err != nil {
				errs = append(errs, fmt.Errorf("approve CSR %s: %w", name, err))
				continue
			}
			Audit("fleet.join", r.Config.Site, d, "", "approved CSR "+name)
			msg := fmt.Sprintf("fleetd: approved the kubelet client certificate request %s, which %s's own bootstrap token %s asked for; the token is deleted once the kubelet has the certificate", name, node, id)
			if err := r.journalOnce(ctx, csrKey(name, "approved"), d, "info", msg); err != nil {
				errs = append(errs, err)
			}
		case csr.pending():
			errs = append(errs, r.leavePending(ctx, csr, id, node, why, devices, byName)...)
		case isApproved && why == "" && len(csr.Status.Certificate) > 0 && now.Sub(approved.LastUpdateTime) >= JoinTokenLinger:
			if err := r.Cluster.RevokeJoinToken(ctx, node); err != nil {
				errs = append(errs, fmt.Errorf("delete %s's spent bootstrap token: %w", node, err))
				continue
			}
			Audit("fleet.join", r.Config.Site, d, "", "spent: CSR "+name+" issued")
			msg := fmt.Sprintf("fleetd: deleted %s's bootstrap token %s: its kubelet has its client certificate from CSR %s", node, id, name)
			if err := r.journalOnce(ctx, csrKey(name, "spent"), d, "info", msg); err != nil {
				errs = append(errs, err)
			}
		}
	}
	r.forgetCSRs(live)
	return errors.Join(errs...)
}

// leavePending journals a bootstrap CSR fleetd does not approve, once, on
// each NetBox device it concerns: the node its CN names, and the node whose
// fleetd token asked, when that is another.
func (r *Reconciler) leavePending(ctx context.Context, csr kubeletCSR, id, node, why string, devices []Device, byName map[string]Device) []error {
	name := csr.Metadata.Name
	owner := tokenOwner(id, devices)
	_, shapeWhy := requestShape(csr)
	kind, msg := "warning", ""
	switch {
	case owner != "" && node != "" && owner != node:
		kind = "danger"
		msg = fmt.Sprintf("fleetd: refused the kubelet client certificate request %s: %s's bootstrap token %s asked for %s's certificate, an attempt to join under another node's name. Do not approve it: delete it, and provision %s again so its token is replaced", name, owner, id, node, owner)
	case owner != "":
		msg = fmt.Sprintf("fleetd: refused the kubelet client certificate request %s from %s's bootstrap token %s: %s. fleetd approves only the node's own unspent token; set desired_action to provision for a new one", name, owner, id, why)
	case shapeWhy != "":
		msg = fmt.Sprintf("fleetd: refused the kubelet client certificate request %s from bootstrap token %s: %s", name, id, why)
	default:
		msg = fmt.Sprintf("fleetd: the kubelet client certificate request %s, from bootstrap token %s, which fleetd does not mint, waits for the owner. A join with the cluster's bootstrap token, such as a control plane's or shale's, is approved by hand, and only for a join the owner started: kubectl certificate approve %s", name, id, name)
	}
	if r.once(csrKey(name, "log")) {
		Audit("fleet.join", r.Config.Site, Device{Name: node}, "", "left CSR "+name+" pending: "+why)
		log.Printf("kubelet CSR %s from bootstrap token %s waits: %s", name, id, why)
	}
	targets := []string{node}
	if owner != "" && owner != node {
		targets = append(targets, owner)
	}
	var errs []error
	for _, n := range targets {
		d, ok := byName[n]
		if !ok {
			continue
		}
		if err := r.journalOnce(ctx, csrKey(name, "pending/"+n), d, kind, msg); err != nil {
			errs = append(errs, err)
		}
	}
	return errs
}

// csrKey is a reported key about one CSR, which forgetCSRs drops once the
// CSR is gone.
func csrKey(csr, what string) string { return "csr/" + csr + "/" + what }

// forgetCSRs drops the reported keys of CSRs the cluster no longer lists,
// so the map holds no more than the live CSRs' keys; the controller manager
// deletes a CSR within a day.
func (r *Reconciler) forgetCSRs(live map[string]bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for key := range r.reported {
		rest, ok := strings.CutPrefix(strings.TrimPrefix(key, "log/"), "csr/")
		if !ok {
			continue
		}
		if name, _, _ := strings.Cut(rest, "/"); !live[name] {
			delete(r.reported, key)
		}
	}
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

// ApprovalBinding is the binding of the controller manager's approval of a
// kubelet's first client certificate, which Talos's bootstrap manifests make
// and node-client-approval.yaml empties.
const ApprovalBinding = "system-bootstrap-approve-node-client-csr"

const approvalBindingPath = "/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/" + ApprovalBinding

// ApprovalPlaceholder is the group node-client-approval.yaml binds in place
// of Talos's, so that Flux owns the binding's subjects. No one is in it.
const ApprovalPlaceholder = "fleetd:no-node-client-approval"

// ApprovalSubjects counts the subjects of ApprovalBinding other than
// ApprovalPlaceholder.
func (c *Cluster) ApprovalSubjects(ctx context.Context) (int, error) {
	var b struct {
		Subjects []struct {
			Kind string `json:"kind"`
			Name string `json:"name"`
		} `json:"subjects"`
	}
	err := c.do(ctx, http.MethodGet, approvalBindingPath, "", nil, &b)
	if errors.Is(err, ErrNotFound) {
		return 0, nil
	}
	n := 0
	for _, s := range b.Subjects {
		if s.Kind != "Group" || s.Name != ApprovalPlaceholder {
			n++
		}
	}
	return n, err
}

// watchJoins reads what each pass needs of the cluster before NetBox, so it
// holds while NetBox does not answer: the kubelet client CSRs, and the
// subjects of ApprovalBinding, which a Talos manifest sync can put back and
// fleetd exports as fleet_node_client_approval_subjects, -1 when it cannot
// read them.
func (r *Reconciler) watchJoins(ctx context.Context) ([]kubeletCSR, error) {
	n, err := r.Cluster.ApprovalSubjects(ctx)
	if err != nil {
		n = -1
		err = fmt.Errorf("read %s: %w", ApprovalBinding, err)
	} else if n > 0 && r.once("approval-binding-subjects") {
		log.Printf("%s binds %d subjects: the controller manager may approve a bootstrap token's request; Flux's tinkerbell-access empties it", ApprovalBinding, n)
	}
	r.Metrics.SetApprovalSubjects(n)
	csrs, lerr := r.Cluster.KubeletCSRs(ctx)
	if lerr != nil {
		lerr = fmt.Errorf("list kubelet CSRs: %w", lerr)
	}
	return csrs, errors.Join(err, lerr)
}
