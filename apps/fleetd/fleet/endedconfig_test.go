package fleet

import (
	"context"
	"testing"
)

func renderedForTest(t *testing.T) *installTest {
	t.Helper()
	it := newInstallTest(t, "planned", nil)
	if code, why := it.render(goodRequest()); code != 201 {
		t.Fatal(code, why)
	}
	return it
}

func TestAnEndedWorkflowDropsItsUnreadConfig(t *testing.T) {
	for _, state := range []string{"STATE_FAILED", "STATE_TIMEOUT"} {
		t.Run(state, func(t *testing.T) {
			it := renderedForTest(t)
			it.kube.setState(provWF, state)
			it.in.Tick(context.Background())
			it.in.Tick(context.Background())
			if _, ok := it.in.Configs.Holds(testUUID); ok || !it.in.Configs.Spent(testUUID, testCode) {
				t.Fatal("the config of an ended Workflow stays fetchable or its code is not burned")
			}
			if n := len(it.nb.JournalWith("fleetd dropped the unread config of riptide: Workflow " + provWF + " ended " + state[len("STATE_"):])); n != 1 {
				t.Fatalf("%d journals: %v", n, it.nb.Journals)
			}
			if it.in.Metrics.ConfigEnded.Load() != 1 {
				t.Fatalf("counted %d", it.in.Metrics.ConfigEnded.Load())
			}
		})
	}
}

func TestAnUnfinishedOrSuccessfulWorkflowKeepsItsConfig(t *testing.T) {
	for _, state := range []string{"STATE_RUNNING", "STATE_PENDING", "STATE_SUCCESS"} {
		it := renderedForTest(t)
		it.kube.setState(provWF, state)
		it.in.Tick(context.Background())
		if _, ok := it.in.Configs.Holds(testUUID); !ok || it.in.Metrics.ConfigEnded.Load() != 0 {
			t.Fatalf("%s: the config was dropped", state)
		}
	}
}

func TestADeletedWorkflowDropsItsUnreadConfig(t *testing.T) {
	it := renderedForTest(t)
	if err := it.in.Kube.Delete(context.Background(), WorkflowResource, provWF); err != nil {
		t.Fatal(err)
	}
	it.in.Tick(context.Background())
	if _, ok := it.in.Configs.Holds(testUUID); ok || !it.in.Configs.Spent(testUUID, testCode) {
		t.Fatal("the config of a deleted Workflow stays fetchable or its code is not burned")
	}
	if len(it.nb.JournalWith("Workflow "+provWF+" was deleted")) != 1 || it.in.Metrics.ConfigEnded.Load() != 1 {
		t.Fatalf("journals %v", it.nb.Journals)
	}
}

func TestAnEndedWorkflowMarksAHeldConfigWithdrawn(t *testing.T) {
	it := renderedForTest(t)
	if _, _, ok := it.in.Configs.Claim(testUUID, testCode, it.now); !ok {
		t.Fatal("no claim")
	}
	it.kube.setState(provWF, "STATE_FAILED")
	it.in.Tick(context.Background())
	it.in.Tick(context.Background())
	p, ok := it.in.Configs.pending[testUUID]
	if !ok || p.Withdrawn.IsZero() || !p.claimed {
		t.Fatalf("a config a fetch holds was dropped or not marked withdrawn: %+v %v", p, ok)
	}
	if len(it.nb.JournalWith("a fetch was writing it")) != 1 || it.in.Metrics.ConfigEnded.Load() != 1 {
		t.Fatalf("journals %v", it.nb.Journals)
	}
	if it.in.Configs.Unclaim(testUUID, testCode) {
		t.Fatal("the fetch's end kept a withdrawn config")
	}
}
