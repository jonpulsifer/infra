package main

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jonpulsifer/infra/apps/fleetd/client"
	"github.com/jonpulsifer/infra/apps/fleetd/protocol"
)

// A verdict exits 3, so HookOS's entrypoint stops trying; an outage, a
// rate limit or a lost session exits 1, and it tries again.
func TestExitCode(t *testing.T) {
	for _, c := range []struct {
		err  error
		want int
	}{
		{&client.RefusedError{Status: http.StatusForbidden}, exitRefused},
		{fmt.Errorf("evidence: %w", &client.RefusedError{Status: http.StatusBadRequest}), exitRefused},
		{&client.RefusedError{Status: http.StatusServiceUnavailable}, 1},
		{&client.RefusedError{Status: http.StatusTooManyRequests}, 1},
		{&client.RefusedError{Status: http.StatusNotFound}, 1},
		{errors.New("dial tcp: connection refused"), 1},
	} {
		if got := exitCode(c.err); got != c.want {
			t.Errorf("exitCode(%v) = %d, want %d", c.err, got, c.want)
		}
	}
}

// HookOS on a machine whose TPM is off or gone sends fleetd nothing, so no
// verdict, and no quarantine, can follow from it; the entrypoint may try
// again.
func TestAttestWithoutATPMSendsNothing(t *testing.T) {
	var requests atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		http.Error(w, "unexpected", http.StatusTeapot)
	}))
	defer ts.Close()
	dir := t.TempDir()
	log := filepath.Join(dir, "binary_bios_measurements")
	if err := os.WriteFile(log, []byte("log"), 0o600); err != nil {
		t.Fatal(err)
	}
	m := protocol.Machine{Serial: "SIM-0001", MAC: "02:00:00:00:00:01"}
	err := run(ts.URL, filepath.Join(dir, "tpmrm0"), log, m, true, filepath.Join(dir, "install_code"), time.Minute, func() *protocol.Network { return nil })
	if err == nil {
		t.Fatal("an attestation without a TPM passed")
	}
	if n := requests.Load(); n != 0 {
		t.Fatalf("an attestation without a TPM sent %d requests", n)
	}
	if code := exitCode(err); code != 1 {
		t.Fatalf("exit %d for a missing TPM, want 1", code)
	}
}
