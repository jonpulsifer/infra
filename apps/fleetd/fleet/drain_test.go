package fleet

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakePod struct {
	ns, name, node      string
	daemon, mirror, end bool
}

type fakeCSR struct{ username, cn string }

// fakeCluster API is the cluster as fleetd's account sees it on a
// retirement: nodes it may cordon and delete, as the admission policy
// admits, pods it may list and evict, CSRs it may list and delete, and the
// bootstrap tokens fakeAPI keeps.
type fakeClusterAPI struct {
	tokens fakeAPI

	mu       sync.Mutex
	down     bool
	nodes    map[string]bool // name: control plane
	cordoned map[string]bool
	pods     []fakePod
	blocked  map[string]bool
	csrs     map[string]fakeCSR
	calls    []string
}

func (f *fakeClusterAPI) server(t *testing.T) *Cluster {
	t.Helper()
	s := httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(s.Close)
	return &Cluster{Server: s.URL, Token: "sa-token", Client: s.Client()}
}

func (f *fakeClusterAPI) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	if f.down {
		f.mu.Unlock()
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/v1/namespaces/kube-system/secrets") {
		f.calls = append(f.calls, r.Method+" token")
		f.mu.Unlock()
		f.tokens.serve(w, r)
		return
	}
	defer f.mu.Unlock()
	const csrs = "/apis/certificates.k8s.io/v1/certificatesigningrequests"
	node, isNode := strings.CutPrefix(r.URL.Path, "/api/v1/nodes/")
	csr, isCSR := strings.CutPrefix(r.URL.Path, csrs+"/")
	switch {
	case isNode && r.Method == http.MethodPatch:
		if _, ok := f.nodes[node]; !ok {
			http.NotFound(w, r)
			return
		}
		f.calls = append(f.calls, "cordon "+node)
		f.cordoned[node] = true
	case isNode && r.Method == http.MethodDelete:
		cp, ok := f.nodes[node]
		if !ok {
			http.NotFound(w, r)
			return
		}
		if cp || !f.cordoned[node] {
			http.Error(w, "the admission policy refuses it", http.StatusForbidden)
			return
		}
		f.calls = append(f.calls, "delete node "+node)
		delete(f.nodes, node)
	case r.URL.Path == "/api/v1/pods" && r.Method == http.MethodGet:
		on := strings.TrimPrefix(r.URL.Query().Get("fieldSelector"), "spec.nodeName=")
		items := []any{}
		for _, p := range f.pods {
			if p.node != on {
				continue
			}
			m := map[string]any{"name": p.name, "namespace": p.ns}
			if p.daemon {
				m["ownerReferences"] = []any{map[string]any{"kind": "DaemonSet"}}
			}
			if p.mirror {
				m["annotations"] = map[string]string{"kubernetes.io/config.mirror": "x"}
			}
			if p.end {
				m["deletionTimestamp"] = "2023-11-14T22:13:20Z"
			}
			items = append(items, map[string]any{"metadata": m})
		}
		json.NewEncoder(w).Encode(map[string]any{"items": items})
		return
	case strings.HasSuffix(r.URL.Path, "/eviction") && r.Method == http.MethodPost:
		parts := strings.Split(r.URL.Path, "/")
		key := parts[4] + "/" + parts[6]
		if f.blocked[key] {
			http.Error(w, "Cannot evict pod as it would violate the pod's disruption budget.", http.StatusTooManyRequests)
			return
		}
		f.calls = append(f.calls, "evict "+key)
		f.pods = slices.DeleteFunc(f.pods, func(p fakePod) bool { return p.ns+"/"+p.name == key })
	case r.URL.Path == csrs && r.Method == http.MethodGet:
		items := []any{}
		for name, c := range f.csrs {
			items = append(items, map[string]any{
				"metadata": map[string]any{"name": name},
				"spec":     map[string]any{"username": c.username, "request": csrPEM(c.cn)},
			})
		}
		json.NewEncoder(w).Encode(map[string]any{"items": items})
		return
	case r.URL.Path == approvalBindingPath && r.Method == http.MethodGet:
		http.NotFound(w, r)
		return
	case isCSR && r.Method == http.MethodDelete:
		if _, ok := f.csrs[csr]; !ok {
			http.NotFound(w, r)
			return
		}
		f.calls = append(f.calls, "delete csr "+csr)
		delete(f.csrs, csr)
	default:
		http.Error(w, "unexpected "+r.Method+" "+r.URL.Path, http.StatusBadRequest)
		return
	}
	w.Write([]byte("{}"))
}

func csrPEM(cn string) []byte {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	der, _ := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{CommonName: cn, Organization: []string{"system:nodes"}}}, key)
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der})
}

const retireWF = "retire-riptide-1700000001"

// newRetiredTest is riptide decommissioning, whose retirement succeeded, in
// a cluster that holds its Node, its pods, its kubelet's CSRs and its
// bootstrap token.
func newRetiredTest(t *testing.T, class string) (*Reconciler, *fakeNetBox, *fakeKube, *fakeClusterAPI) {
	t.Helper()
	cf := map[string]any{"last_workflow": retireWF}
	if class != "" {
		cf["talos_class"] = class
	}
	nb := &fakeNetBox{devices: []map[string]any{device("riptide", "decommissioning", "none", cf)}, ifaces: riptideIfaces()}
	kube := &fakeKube{objects: map[string]Object{wfBase + retireWF: workflowObject(retireWF, "riptide", "retire", testNow.UTC().Format(time.RFC3339), "STATE_SUCCESS")}}
	r, done := newTest(t, nb, kube)
	t.Cleanup(done)
	api := &fakeClusterAPI{
		nodes:    map[string]bool{"riptide": false, "optiplex": true},
		cordoned: map[string]bool{},
		pods: []fakePod{
			{ns: "apps", name: "web", node: "riptide"},
			{ns: "kube-system", name: "cilium", node: "riptide", daemon: true},
			{ns: "kube-system", name: "static", node: "riptide", mirror: true},
			{ns: "apps", name: "going", node: "riptide", end: true},
			{ns: "apps", name: "elsewhere", node: "swell"},
		},
		blocked: map[string]bool{},
		csrs: map[string]fakeCSR{
			"csr-renew":     {"system:node:riptide", "system:node:riptide"},
			"csr-bootstrap": {"system:bootstrap:" + JoinTokenID("riptide"), "system:node:riptide"},
			"csr-swell":     {"system:node:swell", "system:node:swell"},
		},
	}
	r.Cluster = api.server(t)
	if _, err := r.Cluster.Mint(t.Context(), "riptide", testNow.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	return r, nb, kube, api
}

func journaled(nb *fakeNetBox, text string) int {
	nb.mu.Lock()
	defer nb.mu.Unlock()
	n := 0
	for _, j := range nb.journals {
		if strings.Contains(j["comments"].(string), text) {
			n++
		}
	}
	return n
}

// A succeeded retirement cordons the node, evicts what a drain evicts,
// deletes the Node, the kubelet's CSRs and the bootstrap token, and only then
// takes the device offline.
func TestRetirementTakesTheNodeOutOfTheCluster(t *testing.T) {
	r, nb, kube, api := newRetiredTest(t, "")
	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	want := []string{"cordon riptide", "evict apps/web", "delete node riptide", "DELETE token"}
	got := slices.DeleteFunc(slices.Clone(api.calls), func(c string) bool { return strings.HasPrefix(c, "delete csr") || c == "POST token" })
	if !slices.Equal(got, want) {
		t.Fatalf("calls %v, want %v", api.calls, want)
	}
	if _, ok := api.csrs["csr-swell"]; !ok || len(api.csrs) != 1 {
		t.Fatalf("CSRs left %v", api.csrs)
	}
	if len(api.tokens.secrets) != 0 {
		t.Fatalf("tokens left %v", api.tokens.secrets)
	}
	last := lastPatch(nb)
	if last["status"] != "offline" {
		t.Fatalf("final patch %v", last)
	}
	if journaled(nb, "cordoned and drained it and deleted its Node; deleted 2 CSRs of its kubelet and its bootstrap token") != 1 {
		t.Errorf("journals %v", nb.journals)
	}
	if kube.get(hwPath) != nil || kube.get(mPath) != nil {
		t.Error("Hardware or Machine survived the retirement")
	}
}

// With the cluster's API down, the wiped device stays decommissioning and
// keeps its objects; the failure is journaled once and every pass tries
// again, until the API answers and the node goes.
func TestRetirementRetriesTheNodeRemoval(t *testing.T) {
	r, nb, kube, api := newRetiredTest(t, "")
	api.mu.Lock()
	api.down = true
	api.mu.Unlock()
	for range 3 {
		if err := r.Reconcile(context.Background()); err == nil || !strings.Contains(err.Error(), "take riptide out of the cluster") {
			t.Fatalf("a failed removal was not reported: %v", err)
		}
	}
	if p := lastPatch(nb); p != nil {
		t.Fatalf("the device moved while the API was down: %v", nb.patches)
	}
	if journaled(nb, "could not take riptide out of the cluster") != 1 {
		t.Fatalf("journals %v", nb.journals)
	}
	if kube.get(hwPath) == nil {
		t.Fatal("the Hardware went while the removal waits")
	}
	if n := kube.workflows(); len(n) != 1 || n[0] != retireWF {
		t.Fatalf("the retirement ran again: %v", n)
	}
	api.mu.Lock()
	api.down = false
	api.mu.Unlock()
	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, ok := api.nodes["riptide"]; ok || lastPatch(nb)["status"] != "offline" {
		t.Fatalf("after the API came back: nodes %v, patches %v", api.nodes, nb.patches)
	}
}

// An eviction a PodDisruptionBudget refuses holds the Node's deletion, across
// passes and a restart, until DrainTimeout from the first refusal.
func TestRetirementWaitsForAPodDisruptionBudget(t *testing.T) {
	r, nb, kube, api := newRetiredTest(t, "")
	api.blocked["apps/web"] = true
	now := testNow
	r.Now = func() time.Time { return now }
	for range 2 {
		if err := r.Reconcile(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if _, ok := api.nodes["riptide"]; !ok || lastPatch(nb)["status"] == "offline" {
		t.Fatal("the Node went while a PodDisruptionBudget refused its pod's eviction")
	}
	if journaled(nb, "for PodDisruptionBudgets to allow evicting apps/web from riptide") != 1 {
		t.Fatalf("journals %v", nb.journals)
	}
	if kube.get(wfBase + retireWF).Annotations()[DrainStartedAnnotation] != testNow.UTC().Format(time.RFC3339) {
		t.Fatal("the drain's start is not on the Workflow")
	}
	r.reported = nil
	now = testNow.Add(DrainTimeout)
	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, ok := api.nodes["riptide"]; ok || lastPatch(nb)["status"] != "offline" {
		t.Fatalf("the Node outlived the drain's wait: %v", api.nodes)
	}
	if journaled(nb, "removes apps/web, whose eviction PodDisruptionBudgets refused for 10m0s") != 1 {
		t.Fatalf("journals %v", nb.journals)
	}
}

// A Node already gone still loses its CSRs and token; a control plane's Node
// is left alone; without credentials the journal tells the owner.
func TestRetirementWithoutANodeOrCredentials(t *testing.T) {
	r, nb, _, api := newRetiredTest(t, "")
	delete(api.nodes, "riptide")
	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(api.csrs) != 1 || len(api.tokens.secrets) != 0 || journaled(nb, "the cluster holds no Node for it; deleted 2 CSRs") != 1 {
		t.Fatalf("CSRs %v tokens %v journals %v", api.csrs, api.tokens.secrets, nb.journals)
	}

	r, nb, _, api = newRetiredTest(t, "controlplane")
	api.nodes["riptide"] = true
	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(api.calls, []string{"POST token"}) || journaled(nb, "a control plane's Node is the owner's to delete") != 1 {
		t.Fatalf("calls %v journals %v", api.calls, nb.journals)
	}

	r, nb, _, _ = newRetiredTest(t, "")
	r.Cluster = nil
	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if lastPatch(nb)["status"] != "offline" || journaled(nb, "delete its Node and its bootstrap token by hand") != 1 {
		t.Fatalf("patches %v journals %v", nb.patches, nb.journals)
	}
}
