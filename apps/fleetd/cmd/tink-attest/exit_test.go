package main

import (
	"errors"
	"fmt"
	"net/http"
	"testing"

	"github.com/jonpulsifer/infra/apps/fleetd/client"
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
