package fleet

import (
	"net/http"
	"strings"
	"testing"
)

func (at *admitTest) hookosJournals() int {
	n := 0
	for _, j := range at.nb.journals {
		if strings.Contains(j["comments"].(string), "booted HookOS and attested after Workflow") {
			n++
		}
	}
	return n
}

// A provision that succeeded and whose node attests from HookOS again, with
// its config unread, is journaled once per run, across a restart too.
func TestAdmitJournalsAHookOSBootAfterASuccessfulInstall(t *testing.T) {
	at := newAdmitTest(t, rackMAC, []map[string]any{declared(nil)}, []map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
	if code, why := at.admit(testCode); code != http.StatusCreated {
		t.Fatalf("admit: %d %s", code, why)
	}
	run := at.kube.workflows()[0]
	if code, _ := at.admit(strings.Repeat("Q", 43)); code != http.StatusCreated || at.hookosJournals() != 0 {
		t.Fatalf("a running provision journaled: %v", at.nb.journals)
	}
	at.kube.setState(run, "STATE_SUCCESS")
	if code, why := at.admit(testCode); code != http.StatusConflict || !strings.Contains(why, "its last run is "+run) {
		t.Fatalf("answer changed: %d %s", code, why)
	}
	if at.hookosJournals() != 1 || at.r.Metrics.HookOSAfter.Load() != 1 {
		t.Fatalf("journals %v count %d", at.nb.journals, at.r.Metrics.HookOSAfter.Load())
	}
	if _, ok := at.kube.get(wfBase + run).Annotations()[HookOSAfterAnnotation]; !ok {
		t.Fatal("the Workflow is not marked")
	}
	at.admit(testCode)
	at.r.reported = nil
	at.admit(testCode)
	if at.hookosJournals() != 1 || at.r.Metrics.HookOSAfter.Load() != 1 {
		t.Errorf("journaled again: %v", at.nb.journals)
	}
}

// A reprovision or wipe netboots on purpose, and a failed run or a fetched
// config is no boot of HookOS after success.
func TestAdmitJournalsNoHookOSBootForAnythingElse(t *testing.T) {
	for _, tc := range []struct {
		name    string
		desired string
		state   string
		fetched bool
	}{
		{name: "reprovision", desired: "provision", state: "STATE_SUCCESS"},
		{name: "wipe", desired: "wipe", state: "STATE_SUCCESS"},
		{name: "failed", desired: "none", state: "STATE_FAILED"},
		{name: "fetched", desired: "none", state: "STATE_SUCCESS", fetched: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			at := newAdmitTest(t, rackMAC, []map[string]any{declared(nil)}, []map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
			if code, why := at.admit(testCode); code != http.StatusCreated {
				t.Fatalf("admit: %d %s", code, why)
			}
			run := at.kube.workflows()[0]
			at.kube.setState(run, tc.state)
			at.node()["custom_fields"].(map[string]any)["desired_action"] = tc.desired
			if tc.fetched {
				if _, ok := at.r.Installer.Configs.Burn(boxUUID, testCode, testNow); !ok {
					t.Fatal("no config to fetch")
				}
			}
			at.admit(testCode)
			if at.hookosJournals() != 0 || at.r.Metrics.HookOSAfter.Load() != 0 {
				t.Errorf("journals %v", at.nb.journals)
			}
		})
	}
}
