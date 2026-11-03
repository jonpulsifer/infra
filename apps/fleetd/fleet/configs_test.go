package fleet

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func testPending() Pending {
	return Pending{UUID: testUUID, Code: testCode, Serial: "MXL0172Q6L", Node: "riptide", Workflow: provWF, Rendered: testNow, TTL: time.Hour}
}

// fetchOf is a fetch of the test machine's config that any path serves and
// NetBox still wants, whose delivery is deliver.
func fetchOf(now time.Time, deliver func(Pending, []byte) error) Fetch {
	return Fetch{
		UUID: testUUID, Code: testCode, Now: now,
		Serves:  func(string) bool { return true },
		Check:   func(Pending) Verdict { return Verdict{Kind: Wanted} },
		Deliver: deliver,
	}
}

// holdFetch starts a fetch that is writing the config and has not ended; the
// returned func ends it with err and gives its outcome.
func holdFetch(t *testing.T, c *Configs, now time.Time) (end func(err error) Outcome) {
	t.Helper()
	writing, finish, done := make(chan struct{}), make(chan error), make(chan Outcome)
	go func() {
		done <- c.Serve(fetchOf(now, func(Pending, []byte) error {
			close(writing)
			return <-finish
		}))
	}()
	select {
	case <-writing:
	case <-time.After(5 * time.Second):
		t.Fatal("the fetch never claimed the config")
	}
	return func(err error) Outcome {
		finish <- err
		return <-done
	}
}

var errBrokeOff = errors.New("the node broke off")

// The TTL bounds when a fetch may start: a config a fetch holds outlives it
// until the fetch gives it back, and the next pass expires it.
func TestTickKeepsAClaimedConfig(t *testing.T) {
	c := &Configs{}
	if err := c.Put(testPending(), []byte("cfg")); err != nil {
		t.Fatal(err)
	}
	end := holdFetch(t, c, testNow)
	late := testNow.Add(2 * time.Hour)
	if got := c.Tick(late); len(got) != 0 {
		t.Fatalf("a claimed config expired: %+v", got)
	}
	if out := end(errBrokeOff); out.Kind != Undelivered || !out.Stays {
		t.Fatalf("the broken-off fetch: %+v", out)
	}
	if got := c.Tick(late); len(got) != 1 || got[0].Kind != Expired || !c.Spent(testUUID, testCode) {
		t.Fatalf("the unclaimed config outlived its TTL: %+v", got)
	}
}

// Two fetches at once get the config once: the second finds nothing while
// the first writes, and a fetch that breaks off gives it back.
func TestServeGivesAConfigToOneFetchAtATime(t *testing.T) {
	c := &Configs{}
	if err := c.Put(testPending(), []byte("cfg")); err != nil {
		t.Fatal(err)
	}
	end := holdFetch(t, c, testNow)
	if out := c.Serve(fetchOf(testNow, func(Pending, []byte) error { return nil })); out.Kind != Absent {
		t.Fatalf("a second fetch got the config while the first wrote it: %+v", out)
	}
	end(errBrokeOff)
	if out := c.Serve(fetchOf(testNow, func(Pending, []byte) error { return nil })); out.Kind != Delivered {
		t.Fatalf("the fetch after the first broke off: %+v", out)
	}
	if _, held := c.Holds(testUUID); held || !c.Spent(testUUID, testCode) {
		t.Fatal("the delivered config was not burned")
	}
}

// Serve hands the delivery the config bytes, and gives back the config of a
// path that does not serve it, of a device that left, and of a NetBox that
// does not answer.
func TestServeOutcomes(t *testing.T) {
	put := func(t *testing.T) *Configs {
		c := &Configs{}
		if err := c.Put(testPending(), []byte("cfg")); err != nil {
			t.Fatal(err)
		}
		return c
	}
	t.Run("wrong path", func(t *testing.T) {
		c := put(t)
		f := fetchOf(testNow, func(Pending, []byte) error { t.Fatal("delivered"); return nil })
		f.Serves = func(string) bool { return false }
		if out := c.Serve(f); out.Kind != WrongPath {
			t.Fatalf("%+v", out)
		}
		if _, held := c.Holds(testUUID); !held {
			t.Fatal("the config did not stay")
		}
	})
	t.Run("gone settles after the config is given back", func(t *testing.T) {
		c := put(t)
		f := fetchOf(testNow, func(Pending, []byte) error { t.Fatal("delivered"); return nil })
		var settled Event
		f.Check = func(p Pending) Verdict {
			return Verdict{Kind: Gone, Settle: func() { settled, _ = c.Withdraw(p.Serial, testNow) }}
		}
		if out := c.Serve(f); out.Kind != Refused {
			t.Fatalf("%+v", out)
		}
		if settled.Kind != Withdrawn || !c.Spent(testUUID, testCode) {
			t.Fatalf("the withdrawal found the config still held: %+v", settled)
		}
	})
	t.Run("gone gives the config back once", func(t *testing.T) {
		c := put(t)
		f := fetchOf(testNow, func(Pending, []byte) error { t.Fatal("delivered"); return nil })
		var end func(error) Outcome
		f.Check = func(Pending) Verdict {
			return Verdict{Kind: Gone, Settle: func() {
				// A fetch that claims between the give-back and the
				// withdrawal must keep the config the withdrawal marks.
				end = holdFetch(t, c, testNow)
				if ev, ok := c.Withdraw("MXL0172Q6L", testNow); !ok || ev.Kind != WithdrawnWhileFetching {
					t.Fatalf("the withdrawal: %+v %v", ev, ok)
				}
			}}
		}
		if out := c.Serve(f); out.Kind != Refused {
			t.Fatalf("%+v", out)
		}
		if out := end(nil); out.Kind != Delivered {
			t.Fatalf("the concurrent fetch lost the config to a second give-back: %+v", out)
		}
		if _, ok := c.Served(testUUID, testCode); !ok {
			t.Fatal("the concurrent fetch left no served record")
		}
	})
	t.Run("unavailable", func(t *testing.T) {
		c := put(t)
		f := fetchOf(testNow, func(Pending, []byte) error { t.Fatal("delivered"); return nil })
		f.Check = func(Pending) Verdict { return Verdict{Kind: Unavailable} }
		if out := c.Serve(f); out.Kind != Unreachable || !out.Stays {
			t.Fatalf("%+v", out)
		}
		if _, held := c.Holds(testUUID); !held {
			t.Fatal("the config did not stay")
		}
	})
	t.Run("delivered", func(t *testing.T) {
		c := put(t)
		var got []byte
		out := c.Serve(fetchOf(testNow, func(_ Pending, b []byte) error { got = b; return nil }))
		if out.Kind != Delivered || string(got) != "cfg" || out.Pending.FetchedAt() != testNow {
			t.Fatalf("%+v %q", out, got)
		}
	})
	t.Run("replaced", func(t *testing.T) {
		c := put(t)
		out := c.Serve(fetchOf(testNow, func(Pending, []byte) error {
			p := testPending()
			p.Code = strings.Repeat("a", 43)
			return c.Put(p, []byte("new"))
		}))
		if out.Kind != Replaced {
			t.Fatalf("%+v", out)
		}
	})
}

// A withdrawal of a config a fetch holds is reported, and the fetch's end
// settles it: a delivery reports the withdrawal, a failed one drops and
// burns the config.
func TestWithdrawOfAClaimedConfigWaitsForTheFetch(t *testing.T) {
	withdrawn := testNow.Add(time.Minute)
	// serve runs a fetch that is withdrawn while it writes, and ends with
	// err. during runs mid-fetch, after the withdrawal.
	serve := func(t *testing.T, c *Configs, err error, during func()) Outcome {
		return c.Serve(fetchOf(testNow.Add(2*time.Minute), func(Pending, []byte) error {
			ev, ok := c.Withdraw("MXL0172Q6L", withdrawn)
			if !ok || ev.Kind != WithdrawnWhileFetching || !ev.Pending.WithdrawnAt().Equal(withdrawn) {
				t.Fatalf("the withdrawal: %+v ok %v", ev, ok)
			}
			if _, ok := c.Withdraw("MXL0172Q6L", withdrawn); ok {
				t.Fatal("a second withdrawal found the withdrawn config")
			}
			if len(c.unread()) != 0 {
				t.Fatal("a withdrawn config is unread")
			}
			if during != nil {
				during()
			}
			return err
		}))
	}
	setup := func(t *testing.T) *Configs {
		c := &Configs{Dir: t.TempDir()}
		if err := c.Put(testPending(), []byte("cfg")); err != nil {
			t.Fatal(err)
		}
		return c
	}
	t.Run("burn", func(t *testing.T) {
		c := setup(t)
		out := serve(t, c, nil, nil)
		if out.Kind != Delivered || !out.Pending.WithdrawnAt().Equal(withdrawn) || !c.Spent(testUUID, testCode) {
			t.Fatalf("the delivery: %+v", out)
		}
		if _, ok := c.Served(testUUID, testCode); !ok {
			t.Fatal("the served withdrawn config left no record")
		}
	})
	t.Run("unclaim", func(t *testing.T) {
		c := setup(t)
		if out := serve(t, c, errBrokeOff, nil); out.Kind != Undelivered || out.Stays {
			t.Fatalf("a withdrawn config stayed: %+v", out)
		}
		if _, held := c.Holds(testUUID); held || !c.Spent(testUUID, testCode) {
			t.Fatal("the withdrawn config was not dropped and burned")
		}
	})
	t.Run("restart", func(t *testing.T) {
		c := setup(t)
		var restarted *Configs
		serve(t, c, errBrokeOff, func() {
			restarted = &Configs{Dir: c.Dir}
			if err := restarted.Load(); err != nil {
				t.Fatal(err)
			}
		})
		if _, held := restarted.Holds(testUUID); held || !restarted.Spent(testUUID, testCode) {
			t.Fatal("a restart brought back a config withdrawn during a fetch")
		}
	})
}

// Dir keeps a record under the names an earlier fleetd wrote, so a restart
// into this one keeps its pending set.
func TestPendingKeepsItsOnDiskFormat(t *testing.T) {
	p := testPending()
	p.fetched, p.withdrawn = testNow, testNow.Add(time.Minute)
	b, err := json.Marshal(configFile{Pending: p, Config: []byte("x")})
	if err != nil {
		t.Fatal(err)
	}
	var raw struct{ Pending map[string]any }
	if err := json.Unmarshal(b, &raw); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"UUID", "Code", "Serial", "Node", "Class", "Kind", "Workflow", "Rendered", "TTL", "Fetched", "Withdrawn"} {
		if _, ok := raw.Pending[k]; !ok {
			t.Errorf("the record has no %s", k)
		}
	}
	if len(raw.Pending) != 11 {
		t.Errorf("the record has %d fields: %v", len(raw.Pending), raw.Pending)
	}
	var back configFile
	if err := json.Unmarshal(b, &back); err != nil || back.Pending.Code != p.Code || !back.Pending.fetched.Equal(p.fetched) || !back.Pending.withdrawn.Equal(p.withdrawn) || back.Pending.TTL != p.TTL {
		t.Fatalf("round trip: %+v %v", back.Pending, err)
	}
}
