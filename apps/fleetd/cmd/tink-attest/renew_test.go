package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

// A node whose TPM is gone, as a Dell's after a clear with the TPM switched
// off, sends nothing: no request can quarantine it, and the run reports the
// missing device for the log and the service's missing-check alert.
func TestRenewOnceWithoutATPMSendsNothing(t *testing.T) {
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
	err := renewOnce(context.Background(), renewOpts{
		url: ts.URL, device: filepath.Join(dir, "tpmrm0"), eventLog: log, serial: "SIM-0001",
		caBundle: filepath.Join(dir, "devid-ca.pem"), before: time.Hour, timeout: time.Minute, check: true,
	})
	if !errors.Is(err, errNoTPM) {
		t.Fatalf("renewOnce without a TPM: %v", err)
	}
	if n := requests.Load(); n != 0 {
		t.Fatalf("renewOnce without a TPM sent %d requests", n)
	}
}
