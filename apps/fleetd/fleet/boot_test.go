package fleet

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/go-tpm/legacy/tpm2"

	"github.com/jonpulsifer/infra/apps/fleetd/classes"
	"github.com/jonpulsifer/infra/apps/fleetd/protocol"
)

// fakeAK stands in for a session's TPM-resident AK.
type fakeAK struct {
	key   *ecdsa.PrivateKey
	nonce []byte
	seq   uint64
}

func newAK(t *testing.T) *fakeAK {
	t.Helper()
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return &fakeAK{key: k, nonce: []byte("0123456789abcdef0123456789abcdef")}
}

func (a *fakeAK) session(t *testing.T, id, node string) BootSession {
	t.Helper()
	der, err := x509.MarshalPKIXPublicKey(&a.key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	return BootSession{ID: id, Node: node, AK: der, Nonce: a.nonce}
}

// sign makes the next request on the route as fleet-boot's TPM would.
func (a *fakeAK) sign(t *testing.T, route string, report *protocol.BootReport) protocol.BootRequest {
	t.Helper()
	a.seq++
	r, s, err := ecdsa.Sign(rand.Reader, a.key, protocol.BootDigest(a.nonce, route, a.seq, report))
	if err != nil {
		t.Fatal(err)
	}
	sig, err := tpm2.Signature{Alg: tpm2.AlgECDSA, ECC: &tpm2.SignatureECC{HashAlg: tpm2.AlgSHA256, R: r, S: s}}.Encode()
	if err != nil {
		t.Fatal(err)
	}
	return protocol.BootRequest{Seq: a.seq, Report: report, Signature: sig}
}

func post(t *testing.T, h http.Handler, path string, req protocol.BootRequest, out any) int {
	t.Helper()
	b, _ := json.Marshal(req)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodPost, path, bytes.NewReader(b)))
	if out != nil && w.Code == http.StatusOK {
		if err := json.Unmarshal(w.Body.Bytes(), out); err != nil {
			t.Fatal(err)
		}
	}
	return w.Code
}

func runPath(session string) string {
	return strings.Replace(protocol.PathBootRun, "{session}", session, 1)
}

func reportPath(session string) string {
	return strings.Replace(protocol.PathBootReport, "{session}", session, 1)
}

// Under the boot executor a provision keeps its run as an attempt, not a
// Workflow on Tinkerbell's API, and fleet-boot takes it over the session
// the machine attested with: the run's inputs, then each step's report,
// until the reboot ends it.
func TestBootExecutorRunsAProvision(t *testing.T) {
	nb := &fakeNetBox{Devices: []map[string]any{device("riptide", "active", "provision", nil)}, Ifaces: riptideIfaces()}
	kube := &fakeKube{}
	r, done := newTest(t, nb, kube)
	defer done()
	attempts := &Attempts{File: filepath.Join(t.TempDir(), "attempts.json"), Now: r.Now}
	r.Kube.Workflows = attempts

	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if names := kube.workflows(); len(names) != 0 {
		t.Fatalf("Workflows on the API: %v", names)
	}
	runs, err := attempts.List(context.Background(), NodeLabel+"=riptide")
	if err != nil || len(runs) != 1 || !strings.HasPrefix(runs[0].Name(), "provision-riptide-") || Finished(runs[0].State()) {
		t.Fatalf("attempts %v %v", runs, err)
	}
	name := runs[0].Name()
	if cf := nb.Patches[0]["custom_fields"].(map[string]any); cf["last_workflow"] != name {
		t.Errorf("NetBox names %v, not %s", cf["last_workflow"], name)
	}

	ak := newAK(t)
	b := &BootServer{Attempts: attempts, Config: r.Config, Device: r.Device}
	h := b.Handler()
	// Before the attestation hands the session over, no run holds it.
	if code := post(t, h, runPath("s1"), ak.sign(t, protocol.PathBootRun, nil), nil); code != http.StatusNotFound {
		t.Fatalf("an unbound session got %d", code)
	}
	b.BindBoot(context.Background(), ak.session(t, "s1", "riptide"))
	var run protocol.BootRun
	if code := post(t, h, runPath("s1"), ak.sign(t, protocol.PathBootRun, nil), &run); code != http.StatusOK {
		t.Fatalf("run: %d", code)
	}
	if run.Run != name || !run.Wipe || !run.Attest || run.Retire || run.Disk != "/dev/nvme0n1" || run.DiskSerial != "30DF7020FGKL" || run.Action != "provision" {
		t.Errorf("run %+v", run)
	}
	for _, step := range []string{protocol.StepWipe, protocol.StepInstall, protocol.StepNextBoot, protocol.StepReboot} {
		for _, phase := range []string{protocol.PhaseStarted, protocol.PhaseSucceeded} {
			rep := &protocol.BootReport{Run: name, Step: step, Phase: phase}
			if code := post(t, h, reportPath("s1"), ak.sign(t, protocol.PathBootReport, rep), nil); code != http.StatusOK {
				t.Fatalf("%s %s: %d", step, phase, code)
			}
		}
	}
	wf, err := r.Kube.Get(context.Background(), WorkflowResource, name)
	if err != nil || !Succeeded(wf.State()) {
		t.Fatalf("the attempt is %q (%v)", wf.State(), err)
	}
	// The run's end drops the session, so its later requests find no run.
	rep := &protocol.BootReport{Run: name, Step: protocol.StepReboot, Phase: protocol.PhaseStarted}
	if code := post(t, h, reportPath("s1"), ak.sign(t, protocol.PathBootReport, rep), nil); code != http.StatusNotFound {
		t.Errorf("a report after the end got %d", code)
	}
	// A restart of fleetd reads the same record.
	again := &Attempts{File: attempts.File}
	if o, err := again.Get(context.Background(), name); err != nil || !Succeeded(o.State()) {
		t.Errorf("after a restart %v %v", o, err)
	}
}

// Only the session's AK, at a number above the last one taken, moves a run.
func TestBootRequestsNeedTheSessionsAK(t *testing.T) {
	attempts := &Attempts{File: filepath.Join(t.TempDir(), "a.json")}
	ctx := context.Background()
	if err := attempts.Create(ctx, workflowObject("wipe-riptide-1", "riptide", "wipe", "", "")); err != nil {
		t.Fatal(err)
	}
	ak := newAK(t)
	b := &BootServer{Attempts: attempts, Device: func(context.Context, string) (Device, error) { return Device{Name: "riptide", Disk: "/dev/sda"}, nil }}
	b.BindBoot(ctx, ak.session(t, "s1", "riptide"))
	h := b.Handler()

	other := newAK(t)
	other.nonce = ak.nonce
	if code := post(t, h, runPath("s1"), other.sign(t, protocol.PathBootRun, nil), nil); code != http.StatusForbidden {
		t.Errorf("another key got %d", code)
	}
	// A run request signed for the report route does not verify.
	req := ak.sign(t, protocol.PathBootReport, nil)
	if code := post(t, h, runPath("s1"), req, nil); code != http.StatusForbidden {
		t.Errorf("a signature for another route got %d", code)
	}
	req = ak.sign(t, protocol.PathBootRun, nil)
	if code := post(t, h, runPath("s1"), req, nil); code != http.StatusOK {
		t.Fatalf("the session's AK got %d", code)
	}
	if code := post(t, h, runPath("s1"), req, nil); code != http.StatusConflict {
		t.Errorf("a replayed request got %d", code)
	}
	rep := &protocol.BootReport{Run: "provision-other-1", Step: protocol.StepWipe, Phase: protocol.PhaseStarted}
	if code := post(t, h, reportPath("s1"), ak.sign(t, protocol.PathBootReport, rep), nil); code != http.StatusBadRequest {
		t.Errorf("a report for another run got %d", code)
	}
}

// A failed step ends the attempt FAILED with the step and fleet-boot's
// reason, which the Reconciler journals as it does a Workflow's.
func TestBootFailureEndsTheAttempt(t *testing.T) {
	attempts := &Attempts{File: filepath.Join(t.TempDir(), "a.json")}
	ctx := context.Background()
	if err := attempts.Create(ctx, workflowObject("provision-riptide-1", "riptide", "provision", "", "")); err != nil {
		t.Fatal(err)
	}
	ak := newAK(t)
	b := &BootServer{Attempts: attempts, Device: func(context.Context, string) (Device, error) { return Device{Name: "riptide"}, nil }}
	b.BindBoot(ctx, ak.session(t, "s1", "riptide"))
	h := b.Handler()
	post(t, h, runPath("s1"), ak.sign(t, protocol.PathBootRun, nil), nil)
	for _, rep := range []*protocol.BootReport{
		{Run: "provision-riptide-1", Step: protocol.StepWipe, Phase: protocol.PhaseStarted},
		{Run: "provision-riptide-1", Step: protocol.StepWipe, Phase: protocol.PhaseFailed, Detail: "no disk reports the serial X; nothing wiped"},
	} {
		if code := post(t, h, reportPath("s1"), ak.sign(t, protocol.PathBootReport, rep), nil); code != http.StatusOK {
			t.Fatalf("%+v: %d", rep, code)
		}
	}
	o, _ := attempts.Get(ctx, "provision-riptide-1")
	action, state, message := o.FailedAction()
	if o.State() != stateFailed || action != "wipe" || state != "FAILED" || !strings.Contains(message, "no disk reports") {
		t.Errorf("state %q failed %q %q %q", o.State(), action, state, message)
	}
}

// A run that started never resumes in a new boot: a second attestation
// fails it, as a Template's run fails in a new boot.
func TestBootRunDoesNotResumeInANewBoot(t *testing.T) {
	attempts := &Attempts{File: filepath.Join(t.TempDir(), "a.json")}
	ctx := context.Background()
	if err := attempts.Create(ctx, workflowObject("provision-riptide-1", "riptide", "provision", "", "")); err != nil {
		t.Fatal(err)
	}
	ak := newAK(t)
	b := &BootServer{Attempts: attempts, Device: func(context.Context, string) (Device, error) { return Device{Name: "riptide"}, nil }}
	b.BindBoot(ctx, ak.session(t, "s1", "riptide"))
	post(t, b.Handler(), runPath("s1"), ak.sign(t, protocol.PathBootRun, nil), nil)
	b.BindBoot(ctx, newAK(t).session(t, "s2", "riptide"))
	o, _ := attempts.Get(ctx, "provision-riptide-1")
	if _, _, message := o.FailedAction(); o.State() != stateFailed || !strings.Contains(message, "never resumes") {
		t.Errorf("state %q %q", o.State(), message)
	}
}

// The attempts store behaves as the Workflow API does for what the
// Reconciler asks of it.
func TestAttemptsActAsWorkflows(t *testing.T) {
	attempts := &Attempts{File: filepath.Join(t.TempDir(), "a.json")}
	ctx := context.Background()
	wf := workflowObject("wipe-riptide-1", "riptide", "wipe", "", "")
	wf["spec"] = map[string]any{"hardwareMap": map[string]any{"wipe": "true"}}
	if err := attempts.Create(ctx, wf); err != nil {
		t.Fatal(err)
	}
	if err := attempts.Create(ctx, wf); !errors.Is(err, ErrConflict) {
		t.Errorf("a second create: %v", err)
	}
	if err := attempts.Create(ctx, workflowObject("wipe-shale-1", "shale", "wipe", "", "")); err != nil {
		t.Fatal(err)
	}
	got, _ := attempts.List(ctx, ManagedLabel+"="+FieldManager+","+NodeLabel+"=riptide")
	if len(got) != 1 || got[0].Name() != "wipe-riptide-1" || !Unfinished(got) || got[0].Created().IsZero() {
		t.Fatalf("list %v", got)
	}
	if _, ok := got[0].GlobalExecutionStop(); ok {
		t.Error("an attempt nothing took has a deadline")
	}
	if err := attempts.DeleteUnchanged(ctx, "wipe-riptide-1", "7"); !errors.Is(err, ErrConflict) {
		t.Errorf("a stale delete: %v", err)
	}
	if err := attempts.DeleteUnchanged(ctx, "wipe-riptide-1", got[0].ResourceVersion()); err != nil {
		t.Fatal(err)
	}
	if _, err := attempts.Get(ctx, "wipe-riptide-1"); !errors.Is(err, ErrNotFound) {
		t.Errorf("deleted: %v", err)
	}

	// An overdue run's annotation ends it as the controller would.
	ak := newAK(t)
	b := &BootServer{Attempts: attempts, Device: func(context.Context, string) (Device, error) { return Device{Name: "shale"}, nil }}
	b.BindBoot(ctx, ak.session(t, "s9", "shale"))
	post(t, b.Handler(), runPath("s9"), ak.sign(t, protocol.PathBootRun, nil), nil)
	o, _ := attempts.Get(ctx, "wipe-shale-1")
	if _, ok := o.GlobalExecutionStop(); !ok || o.State() != stateRunning {
		t.Fatalf("a started attempt: %q", o.State())
	}
	if err := attempts.Annotate(ctx, "wipe-shale-1", map[string]string{OverdueAnnotation: "now"}); err != nil {
		t.Fatal(err)
	}
	if o, _ := attempts.Get(ctx, "wipe-shale-1"); o.State() != stateTimeout || o.Annotations()[OverdueAnnotation] != "now" {
		t.Errorf("overdue: %q %v", o.State(), o.Annotations())
	}
}

// A Talos class that pins its metal image installs it under the boot
// executor, which Tinkerbell's Template ignores.
func TestBootRunCarriesTheTalosImage(t *testing.T) {
	c := Config{Classes: classes.Table{"worker-g5": {
		OS: "talos", PayloadKind: classes.PayloadTalosConfig,
		Image: "https://example.com/metal-amd64-secureboot.raw.zst", ImageDigest: "sha256:" + strings.Repeat("a", 64), ImageFormat: "raw.zst",
	}}}
	a := Attempt{Name: "provision-x-1", Labels: map[string]string{ActionLabel: "provision"}, Spec: map[string]any{"hardwareMap": map[string]any{
		"install": "true", "wipe": "true", "installer_image": "ghcr.io/x@sha256:" + strings.Repeat("b", 64), "install_disk_serial": "S1",
	}}}
	run := BootRun(a, Device{Class: "worker-g5", Disk: "/dev/nvme0n1"}, c)
	if run.ImageURL != c.Classes["worker-g5"].Image || run.ImageFormat != "raw.zst" || run.PayloadKind != classes.PayloadTalosConfig || run.OS != "talos" {
		t.Errorf("run %+v", run)
	}
	a.Spec["hardwareMap"].(map[string]any)["install"] = "false"
	if run := BootRun(a, Device{Class: "worker-g5"}, c); run.ImageURL != "" {
		t.Errorf("a run that installs nothing carries the image: %+v", run)
	}
}
