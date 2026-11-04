// Package fleetboot runs a boot's run in the lab's RAM boot image: wipe, install, next-boot and
// reboot, in that order, the semantics of the provision and provision-image Templates in
// clusters/folly/tinkerbell/, every disk check and refusal included. Each step reports that it
// started and how it ended before the next one runs, and a failure, or a report fleetd does not
// take, stops the run where it is. Nothing is tried again on the machine.
package fleetboot

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/jonpulsifer/infra/apps/fleetd/protocol"
)

// Host is what the steps do to the machine beyond reading sysfs and
// writing the install disk's device file: run a tool, mount, sync and
// reboot. The tests' Host is a fake, so they touch no block device.
type Host interface {
	Run(ctx context.Context, name string, args ...string) ([]byte, error)
	IsBlockDevice(path string) bool
	IsMountpoint(path string) bool
	Mount(source, target, fstype, data string) error
	// Remount makes a mounted file system writable.
	Remount(target string) error
	Unmount(target string) error
	// ClearImmutable drops the immutable flag efivarfs sets on a variable.
	ClearImmutable(path string) error
	Sync()
	// Reboot restarts the machine, or with off powers it off. It returns
	// only on failure.
	Reboot(off bool) error
}

// Reporter takes a step's report; an error means fleetd did not take it.
type Reporter interface {
	Report(ctx context.Context, r protocol.BootReport) error
}

// Executor runs one boot's run.
type Executor struct {
	Host     Host
	Reporter Reporter
	HTTP     *http.Client
	Logf     func(format string, args ...any)
	// Sys and Dev are the roots of sysfs and of the device nodes; EFIVars
	// is efivarfs's mount point, and RAM a directory in memory for the
	// download and the mounts.
	Sys, Dev, EFIVars, RAM string
	// UUID is the machine's SMBIOS UUID, lower-cased; Code the install code
	// the confirm answered, "" when it answered none.
	UUID, Code string
	// MaxImage caps the download, in bytes.
	MaxImage int64
	// EraseBudget bounds a retirement's erase.
	EraseBudget time.Duration
	// RebootDelay is how long the reboot step waits after its report.
	RebootDelay time.Duration
	// Timeouts bound each step, by name; StepTimeouts has the defaults.
	Timeouts map[string]time.Duration
	Now      func() time.Time

	wiped bool
	// esp is the EFI system partition the install wrote, for next-boot.
	esp *installedESP
}

// installedESP is the install disk's EFI system partition after the write.
type installedESP struct {
	disk Disk
	Partition
}

func (e *Executor) logf(format string, args ...any) {
	if e.Logf != nil {
		e.Logf(format, args...)
	}
}

func (e *Executor) now() time.Time {
	if e.Now != nil {
		return e.Now()
	}
	return time.Now()
}

// StepTimeouts are the image Template's action timeouts: 300 s to wipe,
// 900 s to download and write, 120 s each to set the boot entry and reboot,
// 1,440 s in all under the Templates' global timeout of 1,800 s. A
// retirement's wipe gets RetireWipeTimeout for its erase, and installs
// nothing.
var StepTimeouts = map[string]time.Duration{
	protocol.StepWipe:     300 * time.Second,
	protocol.StepInstall:  900 * time.Second,
	protocol.StepNextBoot: 120 * time.Second,
	protocol.StepReboot:   120 * time.Second,
}

// RetireWipeTimeout is the provision Template's wipe timeout, which a
// retirement's erase needs.
const RetireWipeTimeout = 900 * time.Second

func (e *Executor) timeout(step string, r protocol.BootRun) time.Duration {
	if d, ok := e.Timeouts[step]; ok {
		return d
	}
	if step == protocol.StepWipe && r.Retire {
		return RetireWipeTimeout
	}
	return StepTimeouts[step]
}

// stepFunc runs one step and answers what it did, for the report.
type stepFunc func(ctx context.Context, r protocol.BootRun) (string, error)

// Run takes the run's steps in order and reports each. A run whose install
// inputs are refused fails at the wipe's start, before anything is wiped. The
// reboot, when the run gets there, follows its own report of success.
func (e *Executor) Run(ctx context.Context, r protocol.BootRun) error {
	steps := []struct {
		name string
		fn   stepFunc
	}{
		{protocol.StepWipe, e.wipe},
		{protocol.StepInstall, e.install},
		{protocol.StepNextBoot, e.nextBoot},
		{protocol.StepReboot, e.announceReboot},
	}
	for i, s := range steps {
		if err := e.report(ctx, r, s.name, protocol.PhaseStarted, ""); err != nil {
			return fmt.Errorf("fleetd did not take %s's start, so the run stops before it: %w", s.name, err)
		}
		e.logf("%s: started", s.name)
		var what string
		var err error
		if i == 0 {
			err = preflight(r, e.Code)
		}
		if err == nil {
			sctx, cancel := context.WithTimeout(ctx, e.timeout(s.name, r))
			what, err = s.fn(sctx, r)
			cancel()
		}
		if err != nil {
			e.logf("%s: FAILED: %v", s.name, err)
			if rerr := e.report(ctx, r, s.name, protocol.PhaseFailed, err.Error()); rerr != nil {
				return fmt.Errorf("%s: %w; fleetd did not take the failure: %v", s.name, err, rerr)
			}
			return fmt.Errorf("%s: %w", s.name, err)
		}
		e.logf("%s: %s", s.name, what)
		if err := e.report(ctx, r, s.name, protocol.PhaseSucceeded, what); err != nil {
			return fmt.Errorf("fleetd did not take %s's outcome, so the run stops after it: %w", s.name, err)
		}
	}
	return e.reboot(r)
}

func (e *Executor) report(ctx context.Context, r protocol.BootRun, step, phase, detail string) error {
	if e.Reporter == nil {
		return errors.New("no reporter")
	}
	if len(detail) > 2000 {
		detail = detail[:2000]
	}
	err := e.Reporter.Report(ctx, protocol.BootReport{Run: r.Run, Step: step, Phase: phase, Detail: detail})
	if err != nil {
		e.logf("%s %s: fleetd did not take the report: %v", step, phase, err)
	}
	return err
}

// announceReboot is the reboot step's report: the machine goes down once
// fleetd has it.
func (e *Executor) announceReboot(_ context.Context, r protocol.BootRun) (string, error) {
	if r.Retire {
		return fmt.Sprintf("powering off in %s", e.RebootDelay), nil
	}
	return fmt.Sprintf("rebooting in %s", e.RebootDelay), nil
}

func (e *Executor) reboot(r protocol.BootRun) error {
	time.Sleep(e.RebootDelay)
	e.Host.Sync()
	return e.Host.Reboot(r.Retire)
}
