package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRenderExposesPoolStateAndCounters(t *testing.T) {
	m := newMetrics()
	m.boot("skiff-test")
	m.boot("skiff-test")
	m.exit("skiff-test", exitCompleted)
	m.exit("skiff-test", exitWedged)
	m.githubError()

	got := m.render(
		map[string]poolState{"skiff-test": {idle: 1, busy: 2}},
		map[string]int{"skiff-test": 3},
	)

	for _, want := range []string{
		`bosun_skiffs{class="skiff-test",state="idle"} 1`,
		`bosun_skiffs{class="skiff-test",state="busy"} 2`,
		`bosun_skiffs_desired{class="skiff-test"} 3`,
		`bosun_skiff_boots_total{class="skiff-test"} 2`,
		`bosun_skiff_exits_total{class="skiff-test",reason="completed"} 1`,
		`bosun_skiff_exits_total{class="skiff-test",reason="wedged"} 1`,
		`bosun_skiff_exits_total{class="skiff-test",reason="lifetime"} 0`,
		`bosun_github_errors_total 1`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing series %q in:\n%s", want, got)
		}
	}

	// Every series needs its metadata, or the textfile collector rejects the
	// whole file rather than the line.
	for _, name := range []string{"bosun_skiffs", "bosun_skiffs_desired", "bosun_skiff_boots_total", "bosun_skiff_exits_total", "bosun_github_errors_total"} {
		if !strings.Contains(got, "# TYPE "+name+" ") {
			t.Errorf("missing TYPE line for %s", name)
		}
	}
}

// The mtime is the heartbeat, so the publish path has to actually land a file
// even when nothing has happened yet.
func TestPublishWritesTextfileAndCountsAGuestHalt(t *testing.T) {
	p, _, fl := testPool(t)
	p.cfg.MetricsFile = filepath.Join(t.TempDir(), "sub", "bosun.prom")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	p.fill(ctx)
	body, err := os.ReadFile(p.cfg.MetricsFile)
	if err != nil {
		t.Fatalf("metrics file after fill: %v", err)
	}
	if !strings.Contains(string(body), `bosun_skiffs{class="skiff-test",state="idle"} 1`) {
		t.Fatalf("warm skiff missing from metrics:\n%s", body)
	}

	// A guest that powers itself off is a completed job, not a kill.
	chCall, ok := fl.last("cloud-hypervisor")
	if !ok {
		t.Fatal("cloud-hypervisor was never launched")
	}
	chCall.proc.exit(nil)

	waitFor(t, "completed exit is counted", func() bool {
		body, err := os.ReadFile(p.cfg.MetricsFile)
		return err == nil && strings.Contains(string(body), `bosun_skiff_exits_total{class="skiff-test",reason="completed"} 1`)
	})
}

func TestWriteTextfileIsAtomicOverAnExistingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bosun.prom")
	if err := writeTextfile(path, "first\n"); err != nil {
		t.Fatal(err)
	}
	if err := writeTextfile(path, "second\n"); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "second\n" {
		t.Fatalf("got %q, want the second write", body)
	}
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Fatal("the temporary file was left behind for the collector to read")
	}
}
