package fleet

import (
	"context"
	"testing"
	"time"
)

// A SUCCESS the BMC does not back is a report any host on the Tinkerbell
// channel can make: the node stays in the cluster while the machine is on.
func TestRetirementWaitsForTheBMCToReportPowerOff(t *testing.T) {
	r, nb, kube, api := newRetiredTest(t, "")
	kube.power = "on"
	for range 3 {
		if err := r.Reconcile(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if len(api.calls) != 1 || len(nb.patches) != 0 || kube.get(hwPath) == nil || kube.get(mPath) == nil {
		t.Fatalf("calls %v patches %v: the retirement did not wait", api.calls, nb.patches)
	}
	if n := journaled(nb, "the BMC reports the machine on (Machine status.power); fleetd waits for the power-off"); n != 1 {
		t.Fatalf("%d wait journals: %v", n, nb.journals)
	}
	kube.power = "off"
	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if lastPatch(nb)["status"] != "offline" || journaled(nb, "wiped the disk and powered the node off") != 1 {
		t.Fatalf("patches %v journals %v", nb.patches, nb.journals)
	}
}

func TestRetirementProceedsWhenTheBMCReportsPowerOff(t *testing.T) {
	r, nb, kube, _ := newRetiredTest(t, "")
	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if lastPatch(nb)["status"] != "offline" || journaled(nb, "waits for the power-off") != 0 || kube.get(mPath) != nil {
		t.Fatalf("patches %v journals %v", nb.patches, nb.journals)
	}
}

func TestRetirementGivesUpOnAnUnansweringBMCOnce(t *testing.T) {
	r, nb, kube, api := newRetiredTest(t, "")
	kube.power = ""
	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if journaled(nb, "has not reported the machine's power state") != 1 {
		t.Fatalf("journals %v", nb.journals)
	}
	r.Now = func() time.Time { return testNow.Add(PowerOffWait + time.Minute) }
	for range 2 {
		if err := r.Reconcile(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if journaled(nb, "has not reported riptide off for") != 1 || len(api.calls) != 1 || len(nb.patches) != 0 {
		t.Fatalf("calls %v patches %v journals %v", api.calls, nb.patches, nb.journals)
	}
	if last := nb.journals[len(nb.journals)-1]; last["kind"] != "danger" {
		t.Fatalf("the give-up is %v, not danger", last["kind"])
	}
}

func TestRetirementWithoutABMCSaysTheSuccessIsUncorroborated(t *testing.T) {
	r, nb, _, _ := newRetiredTest(t, "")
	nb.set("bmc_type", "none")
	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if lastPatch(nb)["status"] != "offline" || journaled(nb, "no BMC corroborates") != 1 || journaled(nb, "wiped the disk and powered the node off;") != 0 {
		t.Fatalf("patches %v journals %v", nb.patches, nb.journals)
	}
}
