package fleet

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jonpulsifer/infra/apps/fleetd/classes"
	"github.com/jonpulsifer/infra/apps/fleetd/fleetboot"
	"github.com/jonpulsifer/infra/apps/fleetd/protocol"
)

// bound makes an attempt for riptide and binds a session to it.
func bound(t *testing.T, name string) (*Attempts, *BootServer, *fakeAK, http.Handler) {
	t.Helper()
	attempts := &Attempts{File: filepath.Join(t.TempDir(), "a.json")}
	if err := attempts.Create(context.Background(), workflowObject(name, "riptide", "provision", "", "")); err != nil {
		t.Fatal(err)
	}
	ak := newAK(t)
	b := &BootServer{Attempts: attempts, Device: func(context.Context, string) (Device, error) { return Device{Name: "riptide"}, nil }}
	b.BindBoot(context.Background(), ak.session(t, "s1", "riptide"))
	return attempts, b, ak, b.Handler()
}

// A report no run takes is the client's fault, 400; only an ended or moved
// run is a conflict.
func TestBootReportFaultsAre400(t *testing.T) {
	_, _, ak, h := bound(t, "provision-riptide-1")
	post(t, h, runPath("s1"), ak.sign(t, protocol.PathBootRun, nil), nil)
	for _, rep := range []*protocol.BootReport{
		{Run: "provision-riptide-1", Step: protocol.StepWipe, Phase: "halfway"},
		{Run: "provision-riptide-1", Step: protocol.StepWipe, Phase: protocol.PhaseSucceeded},
		{Run: "provision-riptide-1", Step: "format", Phase: protocol.PhaseStarted},
	} {
		if code := post(t, h, reportPath("s1"), ak.sign(t, protocol.PathBootReport, rep), nil); code != http.StatusBadRequest {
			t.Errorf("%+v: %d", rep, code)
		}
	}
}

// A request refused for its shape or its run leaves the record as it was,
// so its resourceVersion holds for the no-deadline delete.
func TestRefusedBootRequestsChangeNothing(t *testing.T) {
	attempts, _, ak, h := bound(t, "provision-riptide-1")
	before, _ := attempts.Get(context.Background(), "provision-riptide-1")
	for _, rep := range []*protocol.BootReport{
		{Run: "provision-other-1", Step: protocol.StepWipe, Phase: protocol.PhaseStarted},
		{Run: "provision-riptide-1", Step: "format", Phase: protocol.PhaseStarted},
	} {
		if code := post(t, h, reportPath("s1"), ak.sign(t, protocol.PathBootReport, rep), nil); code != http.StatusBadRequest {
			t.Errorf("%+v: %d", rep, code)
		}
	}
	after, _ := attempts.Get(context.Background(), "provision-riptide-1")
	if before.ResourceVersion() != after.ResourceVersion() {
		t.Errorf("resourceVersion %s became %s", before.ResourceVersion(), after.ResourceVersion())
	}
}

// fleetd keeps at most 2000 bytes of a reason, as fleet-boot sends.
func TestBootReportDetailIsCapped(t *testing.T) {
	attempts, _, ak, h := bound(t, "provision-riptide-1")
	post(t, h, runPath("s1"), ak.sign(t, protocol.PathBootRun, nil), nil)
	for _, rep := range []*protocol.BootReport{
		{Run: "provision-riptide-1", Step: protocol.StepWipe, Phase: protocol.PhaseStarted},
		{Run: "provision-riptide-1", Step: protocol.StepWipe, Phase: protocol.PhaseFailed, Detail: strings.Repeat("x", 100000)},
	} {
		if code := post(t, h, reportPath("s1"), ak.sign(t, protocol.PathBootReport, rep), nil); code != http.StatusOK {
			t.Fatalf("%d", code)
		}
	}
	o, _ := attempts.Get(context.Background(), "provision-riptide-1")
	if _, _, msg := o.FailedAction(); len(msg) != maxDetail {
		t.Errorf("a reason of %d bytes", len(msg))
	}
}

// A failed run drops its session: the old boot's requests find no run and
// change nothing.
func TestEndedRunDropsItsSession(t *testing.T) {
	attempts, _, ak, h := bound(t, "provision-riptide-1")
	post(t, h, runPath("s1"), ak.sign(t, protocol.PathBootRun, nil), nil)
	for _, rep := range []*protocol.BootReport{
		{Run: "provision-riptide-1", Step: protocol.StepWipe, Phase: protocol.PhaseStarted},
		{Run: "provision-riptide-1", Step: protocol.StepWipe, Phase: protocol.PhaseFailed, Detail: "no"},
	} {
		post(t, h, reportPath("s1"), ak.sign(t, protocol.PathBootReport, rep), nil)
	}
	before, _ := attempts.Get(context.Background(), "provision-riptide-1")
	if code := post(t, h, runPath("s1"), ak.sign(t, protocol.PathBootRun, nil), nil); code != http.StatusNotFound {
		t.Errorf("the ended run's session got %d", code)
	}
	if after, _ := attempts.Get(context.Background(), "provision-riptide-1"); after.ResourceVersion() != before.ResourceVersion() {
		t.Error("a request on the ended run changed it")
	}
}

// An attempts file that does not parse moves aside, and the store starts
// empty rather than failing every Workflow call.
func TestUnreadableAttemptsMoveAside(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "attempts.json")
	if err := os.WriteFile(file, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	attempts := &Attempts{File: file, Now: func() time.Time { return testNow }}
	if objs, err := attempts.List(context.Background(), ""); err != nil || len(objs) != 0 {
		t.Fatalf("list %v %v", objs, err)
	}
	if _, err := os.Stat(file + ".unreadable-1700000000"); err != nil {
		t.Errorf("the file was not moved aside: %v", err)
	}
	if err := attempts.Create(context.Background(), workflowObject("wipe-riptide-1", "riptide", "wipe", "", "")); err != nil {
		t.Errorf("create after the move: %v", err)
	}
}

// fleet-boot's step budgets fit the attempt's deadline, so a slow legal run
// is never ended mid-install.
func TestStepBudgetsFitTheDeadline(t *testing.T) {
	var install time.Duration
	for _, d := range fleetboot.StepTimeouts {
		install += d
	}
	retire := fleetboot.RetireWipeTimeout + fleetboot.StepTimeouts[protocol.StepNextBoot] + fleetboot.StepTimeouts[protocol.StepReboot]
	if install >= TemplateGlobalTimeout || retire >= TemplateGlobalTimeout {
		t.Errorf("steps take up to %s (install) and %s (retire), and the deadline is %s", install, retire, TemplateGlobalTimeout)
	}
}

// Under the boot executor a failed run's journal points at fleet-boot's log,
// not Tinkerbell's.
func TestBootFailureJournalNamesFleetBoot(t *testing.T) {
	nb := &fakeNetBox{Devices: []map[string]any{device("riptide", "active", "provision", nil)}, Ifaces: riptideIfaces()}
	r, done := newTest(t, nb, &fakeKube{})
	defer done()
	attempts := &Attempts{File: filepath.Join(t.TempDir(), "a.json"), Now: r.Now}
	r.Kube.Workflows = attempts
	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	runs, _ := attempts.List(context.Background(), NodeLabel+"=riptide")
	name := runs[0].Name()
	ak := newAK(t)
	b := &BootServer{Attempts: attempts, Config: r.Config, Device: r.Device}
	b.BindBoot(context.Background(), ak.session(t, "s1", "riptide"))
	h := b.Handler()
	post(t, h, runPath("s1"), ak.sign(t, protocol.PathBootRun, nil), nil)
	for _, rep := range []*protocol.BootReport{
		{Run: name, Step: protocol.StepWipe, Phase: protocol.PhaseStarted},
		{Run: name, Step: protocol.StepWipe, Phase: protocol.PhaseFailed, Detail: "no disk reports the serial"},
	} {
		post(t, h, reportPath("s1"), ak.sign(t, protocol.PathBootReport, rep), nil)
	}
	nb.Set("desired_action", "none")
	nb.Set("last_workflow", name)
	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	got := nb.JournalWith("ended FAILED")
	if len(got) != 1 || !strings.Contains(got[0], "journalctl -t hookos HOOKOS_PROGRAM=fleet-boot") || strings.Contains(got[0], "tinkerbell") || !strings.Contains(got[0], "no disk reports the serial") {
		t.Errorf("journal %q", got)
	}
}

// A Talos class that pins its metal image installs it under the boot
// executor, from the Workflow fleetd builds for the class.
func TestTalosProvisionHandsFleetBootTheImage(t *testing.T) {
	cl := testClasses["worker-g5"]
	cl.PayloadKind, cl.InstallerImage = classes.PayloadTalosConfig, "ghcr.io/jonpulsifer/talos-installer-folly@sha256:"+strings.Repeat("b", 64)
	cl.Image, cl.ImageDigest, cl.ImageFormat = "https://example.com/metal-amd64-secureboot.raw.zst", "sha256:"+strings.Repeat("a", 64), "raw.zst"
	cfg := Config{Classes: classes.Table{"worker-g5": cl}, Installs: map[string]string{"worker-g5": cl.InstallerImage}}
	d := Device{Name: "n", Class: "worker-g5", TPM: "2.0", Disk: "/dev/nvme0n1", DiskSerial: "30DF7020FGKL"}
	attempts := &Attempts{File: filepath.Join(t.TempDir(), "a.json")}
	if err := attempts.Create(context.Background(), mustWorkflow(t, cfg, d, "provision")); err != nil {
		t.Fatal(err)
	}
	var a Attempt
	for _, rec := range attempts.recs {
		a = *rec
	}
	run := BootRun(a, d, cfg)
	if !run.Install || run.ImageURL != cl.Image || run.ImageDigest != cl.ImageDigest || run.PayloadKind != classes.PayloadTalosConfig || run.OS != "talos" {
		t.Errorf("run %+v", run)
	}
}
