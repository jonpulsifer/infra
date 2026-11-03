package fleet

import (
	"fmt"
	"os"
	"time"
)

// The executors that run a device's runs. Under tinkerbell, Tinkerbell runs
// each Workflow from HookOS; under boot, fleet-boot runs it, fleetd keeps the
// run as an attempt record, and Tinkerbell holds no Workflow.
const (
	ExecutorTinkerbell = "tinkerbell"
	ExecutorBoot       = "boot"
)

// LoadExecutor reads FLEET_EXECUTOR, tinkerbell when unset, and under boot
// FLEET_ATTEMPTS_FILE, the attempt records' file in fleetd's state
// directory. The attempts are nil under tinkerbell.
func LoadExecutor(now func() time.Time) (string, *Attempts, error) {
	executor := os.Getenv("FLEET_EXECUTOR")
	switch executor {
	case "", ExecutorTinkerbell:
		return ExecutorTinkerbell, nil, nil
	case ExecutorBoot:
		file := os.Getenv("FLEET_ATTEMPTS_FILE")
		if file == "" {
			return "", nil, fmt.Errorf("FLEET_EXECUTOR=%s needs FLEET_ATTEMPTS_FILE", ExecutorBoot)
		}
		return ExecutorBoot, &Attempts{File: file, Now: now}, nil
	}
	return "", nil, fmt.Errorf("FLEET_EXECUTOR is %q, not %s or %s", executor, ExecutorTinkerbell, ExecutorBoot)
}
