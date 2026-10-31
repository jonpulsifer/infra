package fleet

import (
	"testing"
	"time"
)

func testPending() Pending {
	return Pending{UUID: testUUID, Code: testCode, Serial: "MXL0172Q6L", Node: "riptide", Workflow: provWF, Rendered: testNow, TTL: time.Hour}
}

// The TTL bounds when a fetch may start: a config a fetch holds outlives it
// until the fetch gives it back, and the next pass expires it.
func TestExpireKeepsAClaimedConfig(t *testing.T) {
	c := &Configs{}
	if err := c.Put(testPending(), []byte("cfg")); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := c.Claim(testUUID, testCode, testNow); !ok {
		t.Fatal("no claim")
	}
	late := testNow.Add(2 * time.Hour)
	if got := c.Expire(late); len(got) != 0 {
		t.Fatalf("a claimed config expired: %+v", got)
	}
	if !c.Unclaim(testUUID, testCode) {
		t.Fatal("the unclaimed config did not stay")
	}
	if got := c.Expire(late); len(got) != 1 || !c.Spent(testUUID, testCode) {
		t.Fatalf("the unclaimed config outlived its TTL: %+v", got)
	}
}

// A withdrawal of a config a fetch holds is reported, and the fetch's end
// settles it: a Burn reports the withdrawal, an Unclaim drops and burns it.
func TestDropOfAClaimedConfigWaitsForTheFetch(t *testing.T) {
	withdrawn := testNow.Add(time.Minute)
	setup := func(t *testing.T) *Configs {
		c := &Configs{Dir: t.TempDir()}
		if err := c.Put(testPending(), []byte("cfg")); err != nil {
			t.Fatal(err)
		}
		if _, _, ok := c.Claim(testUUID, testCode, testNow); !ok {
			t.Fatal("no claim")
		}
		p, fetching, ok := c.Drop("MXL0172Q6L", withdrawn)
		if !ok || !fetching || !p.Withdrawn.Equal(withdrawn) {
			t.Fatalf("the drop: %+v fetching %v ok %v", p, fetching, ok)
		}
		if _, again, ok := c.Drop("MXL0172Q6L", withdrawn); ok || again {
			t.Fatal("a second drop found the withdrawn config")
		}
		if len(c.Unread()) != 0 {
			t.Fatal("a withdrawn config is unread")
		}
		return c
	}
	t.Run("burn", func(t *testing.T) {
		c := setup(t)
		p, ok := c.Burn(testUUID, testCode, withdrawn.Add(time.Second))
		if !ok || !p.Withdrawn.Equal(withdrawn) || !c.Spent(testUUID, testCode) {
			t.Fatalf("the burn: %+v %v", p, ok)
		}
		if _, ok := c.Served(testUUID, testCode); !ok {
			t.Fatal("the served withdrawn config left no record")
		}
	})
	t.Run("unclaim", func(t *testing.T) {
		c := setup(t)
		if c.Unclaim(testUUID, testCode) {
			t.Fatal("a withdrawn config stayed")
		}
		if _, held := c.Holds(testUUID); held || !c.Spent(testUUID, testCode) {
			t.Fatal("the withdrawn config was not dropped and burned")
		}
	})
	t.Run("restart", func(t *testing.T) {
		c := setup(t)
		r := &Configs{Dir: c.Dir}
		if err := r.Load(); err != nil {
			t.Fatal(err)
		}
		if _, held := r.Holds(testUUID); held || !r.Spent(testUUID, testCode) {
			t.Fatal("a restart brought back a config withdrawn during a fetch")
		}
	})
}
