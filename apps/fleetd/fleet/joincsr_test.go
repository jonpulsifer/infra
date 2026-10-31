package fleet

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

func kubeletRequest(t *testing.T, cn string, edit func(*x509.CertificateRequest)) []byte {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.CertificateRequest{Subject: pkix.Name{CommonName: cn, Organization: []string{"system:nodes"}}}
	if edit != nil {
		edit(tmpl)
	}
	der, err := x509.CreateCertificateRequest(rand.Reader, tmpl, key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der})
}

// A kubelet client request is CN=system:node:<name> and O=system:nodes and
// nothing else, for client authentication.
func TestKubeletClientNode(t *testing.T) {
	kubelet := []string{"digital signature", "client auth"}
	good := kubeletRequest(t, "system:node:riptide", nil)
	block, _ := pem.Decode(good)
	der := slices.Clone(block.Bytes)
	der[len(der)-3] ^= 0xff
	tampered := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der})
	for _, c := range []struct {
		name    string
		request []byte
		usages  []string
		node    string
		refused string
	}{
		{"the kubelet's request", good, kubelet, "riptide", ""},
		{"an RSA kubelet's usages", good, []string{"digital signature", "key encipherment", "client auth"}, "riptide", ""},
		{"no client auth", good, []string{"digital signature"}, "riptide", "client authentication"},
		{"server auth", good, []string{"digital signature", "client auth", "server auth"}, "riptide", `"server auth"`},
		{"not a node", kubeletRequest(t, "system:admin", nil), kubelet, "", "names no node"},
		{"an empty node", kubeletRequest(t, "system:node:", nil), kubelet, "", "names no node"},
		{"another O", kubeletRequest(t, "system:node:riptide", func(r *x509.CertificateRequest) { r.Subject.Organization = []string{"system:masters"} }), kubelet, "riptide", "O=system:nodes"},
		{"a second O", kubeletRequest(t, "system:node:riptide", func(r *x509.CertificateRequest) {
			r.Subject.Organization = []string{"system:nodes", "system:masters"}
		}), kubelet, "riptide", "O=system:nodes"},
		{"an OU", kubeletRequest(t, "system:node:riptide", func(r *x509.CertificateRequest) { r.Subject.OrganizationalUnit = []string{"x"} }), kubelet, "riptide", "more than a CN"},
		{"a DNS name", kubeletRequest(t, "system:node:riptide", func(r *x509.CertificateRequest) { r.DNSNames = []string{"riptide"} }), kubelet, "riptide", "alternative names"},
		{"an IP", kubeletRequest(t, "system:node:riptide", func(r *x509.CertificateRequest) { r.IPAddresses = []net.IP{net.IPv4(10, 0, 0, 1)} }), kubelet, "riptide", "alternative names"},
		{"a bad signature", tampered, kubelet, "", "signature"},
		{"two requests", append(slices.Clone(good), good...), kubelet, "", "one PEM"},
		{"no PEM", []byte("riptide"), kubelet, "", "one PEM"},
	} {
		node, why := kubeletClientNode(c.request, c.usages)
		if node != c.node || (c.refused == "") != (why == "") || !strings.Contains(why, c.refused) {
			t.Errorf("%s: %q, %q", c.name, node, why)
		}
	}
}

type joinCSR struct {
	username string
	groups   []string
	request  []byte
	created  time.Time
	usages   []string
	approved time.Time
	issued   bool
}

// fakeJoinAPI is the cluster as fleetd's account sees a join: the
// bootstrap tokens fakeAPI keeps, and kubelet client CSRs it may list and
// approve. A renewal, which a node asks for as itself, is in the list too.
type fakeJoinAPI struct {
	tokens fakeAPI

	mu        sync.Mutex
	csrs      map[string]*joinCSR
	approvals []string
	// subjects are ApprovalBinding's subjects; down fails its read.
	subjects    int
	bindingDown bool
}

func (f *fakeJoinAPI) server(t *testing.T) *Cluster {
	t.Helper()
	s := httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(s.Close)
	return &Cluster{Server: s.URL, Token: "sa-token", Client: s.Client(), Ledger: &JoinLedger{}}
}

func (f *fakeJoinAPI) serve(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/v1/namespaces/kube-system/secrets") {
		f.tokens.serve(w, r)
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	name, approval := strings.CutSuffix(strings.TrimPrefix(r.URL.Path, csrPath+"/"), "/approval")
	switch {
	case r.Method == http.MethodGet && r.URL.Path == approvalBindingPath:
		if f.bindingDown {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		subjects := []any{}
		for range f.subjects {
			subjects = append(subjects, map[string]any{"kind": "Group", "name": JoinGroup})
		}
		json.NewEncoder(w).Encode(map[string]any{"subjects": subjects})
	case r.Method == http.MethodGet && r.URL.Path == csrPath:
		if r.URL.Query().Get("fieldSelector") != "spec.signerName="+KubeletClientSigner {
			http.Error(w, "unexpected selector", http.StatusBadRequest)
			return
		}
		items := []any{}
		for name, c := range f.csrs {
			groups := c.groups
			switch {
			case groups != nil:
			case strings.HasPrefix(c.username, "system:bootstrap:"):
				groups = []string{"system:authenticated", "system:bootstrappers", JoinGroup}
			default:
				groups = []string{"system:authenticated", "system:nodes"}
			}
			usages := c.usages
			if usages == nil {
				usages = []string{"digital signature", "client auth"}
			}
			status := map[string]any{}
			if !c.approved.IsZero() {
				status["conditions"] = []any{map[string]any{"type": "Approved", "status": "True", "lastUpdateTime": c.approved.UTC().Format(time.RFC3339)}}
			}
			if c.issued {
				status["certificate"] = []byte("cert")
			}
			items = append(items, map[string]any{
				"metadata": map[string]any{"name": name, "creationTimestamp": c.created.UTC().Format(time.RFC3339), "resourceVersion": "1"},
				"spec":     map[string]any{"signerName": KubeletClientSigner, "username": c.username, "groups": groups, "usages": usages, "request": c.request},
				"status":   status,
			})
		}
		json.NewEncoder(w).Encode(map[string]any{"items": items})
	case r.Method == http.MethodPut && approval:
		c, ok := f.csrs[name]
		if !ok {
			http.NotFound(w, r)
			return
		}
		var body struct {
			Metadata struct {
				Name            string `json:"name"`
				ResourceVersion string `json:"resourceVersion"`
			} `json:"metadata"`
			Status struct {
				Conditions []csrCondition `json:"conditions"`
			} `json:"status"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Metadata.Name != name || body.Metadata.ResourceVersion != "1" ||
			len(body.Status.Conditions) != 1 || body.Status.Conditions[0].Type != "Approved" || body.Status.Conditions[0].Status != "True" {
			http.Error(w, "a malformed approval", http.StatusBadRequest)
			return
		}
		c.approved = body.Status.Conditions[0].LastUpdateTime
		f.approvals = append(f.approvals, name)
		w.Write([]byte("{}"))
	default:
		http.Error(w, "unexpected "+r.Method+" "+r.URL.Path, http.StatusBadRequest)
	}
}

func (f *fakeJoinAPI) issue(name string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.csrs[name].issued = true
}

// newJoinTest is folly with riptide being installed, whose token fleetd
// minted at testNow, shale and swell joined long ago, swell now
// decommissioning, and optiplex the control plane.
func newJoinTest(t *testing.T) (*Reconciler, *fakeNetBox, *fakeJoinAPI, *time.Time) {
	t.Helper()
	nb := &fakeNetBox{devices: []map[string]any{
		device("riptide", "active", "none", nil),
		mergeID(device("optiplex", "active", "none", map[string]any{"talos_class": "controlplane"}), 8),
		mergeID(device("shale", "active", "none", nil), 9),
		mergeID(device("swell", "decommissioning", "none", nil), 10),
	}, ifaces: riptideIfaces()}
	r, done := newTest(t, nb, &fakeKube{})
	t.Cleanup(done)
	api := &fakeJoinAPI{csrs: map[string]*joinCSR{}}
	r.Cluster = api.server(t)
	clock := testNow
	r.Now = func() time.Time { return clock }
	if _, err := r.Cluster.Mint(t.Context(), "riptide", testNow.Add(6*time.Hour)); err != nil {
		t.Fatal(err)
	}
	api.tokens.created = testNow.Add(-2 * time.Hour)
	if _, err := r.Cluster.Mint(t.Context(), "swell", testNow.Add(4*time.Hour)); err != nil {
		t.Fatal(err)
	}
	return r, nb, api, &clock
}

func journalFor(nb *fakeNetBox, part string) []string {
	var out []string
	for _, j := range nb.journals {
		if c := j["comments"].(string); strings.Contains(c, part) {
			out = append(out, c)
		}
	}
	return out
}

// fleetd approves only the request a node's own token makes for that node,
// and deletes the token once the kubelet has its certificate. Every other
// bootstrap request waits, journaled on the devices it concerns; only one
// from a token fleetd does not mint gets the command that approves it. A
// renewal is the controller manager's.
func TestApproveJoinsBindsTheCertificateToTheToken(t *testing.T) {
	r, nb, api, clock := newJoinTest(t)
	riptide := "system:bootstrap:" + JoinTokenID("riptide")
	at := testNow.Add(time.Minute)
	api.csrs = map[string]*joinCSR{
		"bound":        {username: riptide, request: kubeletRequest(t, "system:node:riptide", nil), created: at},
		"other-node":   {username: riptide, request: kubeletRequest(t, "system:node:optiplex", nil), created: at},
		"cluster-wide": {username: "system:bootstrap:b3qcf7", request: kubeletRequest(t, "system:node:shale", nil), created: at},
		"older-token":  {username: riptide, request: kubeletRequest(t, "system:node:riptide", nil), created: testNow.Add(-time.Minute)},
		"server-auth":  {username: riptide, request: kubeletRequest(t, "system:node:riptide", nil), created: at, usages: []string{"client auth", "server auth"}},
		"no-group":     {username: riptide, groups: []string{"system:authenticated", "system:bootstrappers"}, request: kubeletRequest(t, "system:node:riptide", nil), created: at},
		"retiring":     {username: "system:bootstrap:" + JoinTokenID("swell"), request: kubeletRequest(t, "system:node:swell", nil), created: at},
		"renewal":      {username: "system:node:shale", request: kubeletRequest(t, "system:node:shale", nil), created: at},
	}
	*clock = at.Add(time.Minute)
	for range 2 {
		if err := r.Reconcile(t.Context()); err != nil {
			t.Fatal(err)
		}
	}
	if !slices.Equal(api.approvals, []string{"bound"}) {
		t.Fatalf("approved %v", api.approvals)
	}
	for csr, want := range map[string]struct {
		kind, part string
		devices    int
	}{
		"other-node":   {"danger", "riptide's bootstrap token " + JoinTokenID("riptide") + " asked for optiplex's certificate", 2},
		"cluster-wide": {"warning", "kubectl certificate approve cluster-wide", 1},
		"older-token":  {"warning", "older than riptide's newest", 1},
		"server-auth":  {"warning", `"server auth"`, 1},
		"no-group":     {"warning", "not in " + JoinGroup, 1},
		"retiring":     {"warning", "swell is decommissioning", 1},
	} {
		var got []map[string]any
		for _, j := range nb.journals {
			if c := j["comments"].(string); strings.Contains(c, "request "+csr+" ") || strings.Contains(c, "request "+csr+",") || strings.Contains(c, "request "+csr+":") {
				got = append(got, j)
			}
		}
		if len(got) != want.devices {
			t.Errorf("%s: %d journal entries, want %d: %v", csr, len(got), want.devices, got)
			continue
		}
		for _, j := range got {
			c := j["comments"].(string)
			if j["kind"] != want.kind || !strings.Contains(c, want.part) || (csr != "cluster-wide" && strings.Contains(c, "kubectl certificate approve")) {
				t.Errorf("%s: %v", csr, j)
			}
		}
	}
	if journalFor(nb, "renewal") != nil {
		t.Error("a renewal was journaled")
	}
	if len(journalFor(nb, "approved the kubelet client certificate request bound")) != 1 {
		t.Errorf("the approval's journal: %v", nb.journals)
	}

	// The token is spent on its first approval: another request it makes
	// in the minute before fleetd deletes it is refused.
	api.csrs["second"] = &joinCSR{username: riptide, request: kubeletRequest(t, "system:node:riptide", nil), created: at.Add(time.Second)}
	if err := r.Reconcile(t.Context()); err != nil {
		t.Fatal(err)
	}
	if len(api.approvals) != 1 || len(journalFor(nb, "spent: fleetd approved CSR bound")) != 1 {
		t.Fatalf("a second request: approvals %v, journals %v", api.approvals, nb.journals)
	}

	// The token lives until the certificate is issued and a minute has
	// passed since the approval, for the kubelet to read it.
	token := "bootstrap-token-" + JoinTokenID("riptide")
	*clock = clock.Add(2 * time.Minute)
	if err := r.Reconcile(t.Context()); err != nil {
		t.Fatal(err)
	}
	if api.tokens.secret(token) == nil {
		t.Fatal("the token went before the certificate was issued")
	}
	api.issue("bound")
	*clock = at.Add(time.Minute + 30*time.Second)
	if err := r.Reconcile(t.Context()); err != nil {
		t.Fatal(err)
	}
	if api.tokens.secret(token) == nil {
		t.Fatal("the token went within a minute of the approval")
	}
	*clock = at.Add(5 * time.Minute)
	if err := r.Reconcile(t.Context()); err != nil {
		t.Fatal(err)
	}
	if api.tokens.secret(token) != nil {
		t.Fatal("the spent token is still there")
	}
	if _, ok, _ := r.Cluster.Ledger.Get("riptide"); ok {
		t.Fatal("the ledger still holds the spent token")
	}
	if len(journalFor(nb, "deleted riptide's bootstrap token")) != 1 {
		t.Errorf("the spend's journal: %v", nb.journals)
	}

	// The token is gone, so a new request with it waits, and nothing more
	// is approved.
	api.csrs["late"] = &joinCSR{username: riptide, request: kubeletRequest(t, "system:node:riptide", nil), created: clock.Add(-time.Second)}
	if err := r.Reconcile(t.Context()); err != nil {
		t.Fatal(err)
	}
	if len(api.approvals) != 1 || len(journalFor(nb, "no live bootstrap token of its own for riptide")) != 1 {
		t.Fatalf("after the spend: approvals %v, journals %v", api.approvals, nb.journals)
	}
}

// An expired token approves nothing, and nor does a token fleetd has no
// record of, as after a restart without a config directory.
func TestApproveJoinsRefusesAnExpiredOrUnknownToken(t *testing.T) {
	r, nb, api, clock := newJoinTest(t)
	riptide := "system:bootstrap:" + JoinTokenID("riptide")
	api.csrs = map[string]*joinCSR{"late": {username: riptide, request: kubeletRequest(t, "system:node:riptide", nil), created: testNow.Add(time.Minute)}}
	*clock = testNow.Add(6 * time.Hour)
	if err := r.Reconcile(t.Context()); err != nil {
		t.Fatal(err)
	}
	if len(api.approvals) != 0 || len(journalFor(nb, "riptide's bootstrap token expired")) != 1 {
		t.Fatalf("approvals %v, journals %v", api.approvals, nb.journals)
	}

	r, nb, api, clock = newJoinTest(t)
	r.Cluster.Ledger = &JoinLedger{}
	api.csrs = map[string]*joinCSR{"unknown": {username: riptide, request: kubeletRequest(t, "system:node:riptide", nil), created: testNow.Add(time.Minute)}}
	*clock = testNow.Add(2 * time.Minute)
	if err := r.Reconcile(t.Context()); err != nil {
		t.Fatal(err)
	}
	if len(api.approvals) != 0 || len(journalFor(nb, "no live bootstrap token of its own")) != 1 {
		t.Fatalf("approvals %v, journals %v", api.approvals, nb.journals)
	}
}

// The ledger keeps each node's newest token in its file across a restart,
// and drops a record past its expiry.
func TestJoinLedgerSurvivesARestart(t *testing.T) {
	file := filepath.Join(t.TempDir(), "configs", joinLedgerFile)
	l := &JoinLedger{File: file}
	now := time.Now().UTC().Truncate(time.Second)
	live := JoinRecord{ID: "abc123", Created: now, Expires: now.Add(time.Hour)}
	if err := l.Put("riptide", live); err != nil {
		t.Fatal(err)
	}
	if err := l.Put("swell", JoinRecord{ID: "def456", Created: now.Add(-9 * time.Hour), Expires: now.Add(-time.Hour)}); err != nil {
		t.Fatal(err)
	}
	restarted := &JoinLedger{File: file}
	if got, ok, err := restarted.Get("riptide"); err != nil || !ok || got != live {
		t.Fatalf("riptide: %v %v %v", got, ok, err)
	}
	if _, ok, _ := restarted.Get("swell"); ok {
		t.Fatal("an expired record survived")
	}
	if err := restarted.Drop("riptide"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := (&JoinLedger{File: file}).Get("riptide"); ok {
		t.Fatal("a dropped record survived")
	}
	var nilLedger *JoinLedger
	if err := nilLedger.Put("riptide", live); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := nilLedger.Get("riptide"); ok || err != nil {
		t.Fatal("a nil ledger holds a record")
	}
}

// A mint records the token with the API server's creation time.
func TestMintRecordsTheToken(t *testing.T) {
	api := &fakeAPI{created: testNow.Add(time.Second)}
	c := api.server(t)
	c.Ledger = &JoinLedger{}
	expires := testNow.Add(6 * time.Hour)
	if _, err := c.Mint(t.Context(), "riptide", expires); err != nil {
		t.Fatal(err)
	}
	got, ok, err := c.Ledger.Get("riptide")
	want := JoinRecord{ID: JoinTokenID("riptide"), Created: testNow.Add(time.Second).UTC(), Expires: expires.UTC()}
	if err != nil || !ok || !got.Created.Equal(want.Created) || !got.Expires.Equal(want.Expires) || got.ID != want.ID {
		t.Fatalf("%v %v %v", got, ok, err)
	}
	if err := c.RevokeJoinToken(t.Context(), "riptide"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := c.Ledger.Get("riptide"); ok {
		t.Fatal("a revoked token is still recorded")
	}
}

func approvalSubjectsMetric(t *testing.T, m *Metrics) string {
	t.Helper()
	rec := httptest.NewRecorder()
	m.ServeHTTP(rec, nil)
	for _, line := range strings.Split(rec.Body.String(), "\n") {
		if v, ok := strings.CutPrefix(line, "fleet_node_client_approval_subjects "); ok {
			return v
		}
	}
	return ""
}

// Each pass reads the controller manager's approval binding before NetBox,
// so its metric holds while NetBox does not answer: its subjects, or -1
// when fleetd cannot read it. Without the cluster's API there is no metric.
func TestApprovalBindingIsWatched(t *testing.T) {
	r, _, api, _ := newJoinTest(t)
	if err := r.Reconcile(t.Context()); err != nil {
		t.Fatal(err)
	}
	if got := approvalSubjectsMetric(t, r.Metrics); got != "0" {
		t.Fatalf("metric %q, want 0", got)
	}
	api.subjects = 1
	r.NetBox.URL = "http://127.0.0.1:1"
	if err := r.Reconcile(t.Context()); err == nil || !strings.Contains(err.Error(), "NetBox") {
		t.Fatalf("a pass without NetBox: %v", err)
	}
	if got := approvalSubjectsMetric(t, r.Metrics); got != "1" {
		t.Fatalf("metric %q while NetBox is down, want 1", got)
	}
	api.bindingDown = true
	if err := r.Reconcile(t.Context()); err == nil {
		t.Fatal("an unreadable binding is no error")
	}
	if got := approvalSubjectsMetric(t, r.Metrics); got != "-1" {
		t.Fatalf("metric %q, want -1", got)
	}
	if got := approvalSubjectsMetric(t, NewMetrics()); got != "" {
		t.Fatalf("metric %q without the cluster's API", got)
	}
}

// The keys fleetd keeps to journal a CSR once go with the CSR.
func TestReportedKeysGoWithTheirCSR(t *testing.T) {
	r, nb, api, clock := newJoinTest(t)
	api.csrs = map[string]*joinCSR{"cluster-wide": {username: "system:bootstrap:b3qcf7", request: kubeletRequest(t, "system:node:shale", nil), created: testNow}}
	*clock = testNow.Add(time.Minute)
	for range 2 {
		if err := r.Reconcile(t.Context()); err != nil {
			t.Fatal(err)
		}
	}
	csrKeys := func() int {
		r.mu.Lock()
		defer r.mu.Unlock()
		n := 0
		for k := range r.reported {
			if strings.Contains(k, "csr/") {
				n++
			}
		}
		return n
	}
	if csrKeys() == 0 || len(journalFor(nb, "request cluster-wide,")) != 1 {
		t.Fatalf("keys %v, journals %v", r.reported, nb.journals)
	}
	api.csrs = map[string]*joinCSR{}
	if err := r.Reconcile(t.Context()); err != nil {
		t.Fatal(err)
	}
	if n := csrKeys(); n != 0 {
		t.Fatalf("%d keys of a deleted CSR remain: %v", n, r.reported)
	}
}
