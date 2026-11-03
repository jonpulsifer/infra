// fleet-boot is what the lab's own RAM boot image runs (nix/images/fleet-boot.nix): it sets the
// clock, attests the machine against fleetd as tink-attest does from HookOS, then asks fleetd,
// over the session that passed, what this boot does, and runs it. Its command line, which the UKI
// signs, names fleetd's device flow (fleet_attest_url), the NTP server (fleet_ntp_server) and the
// syslog receiver (syslog_host). A boot fleetd holds no run for, and a fleetd that serves no boot
// route, leave the machine waiting here, attested, until it is turned off or booted again.
package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/google/go-tpm/legacy/tpm2"

	"github.com/jonpulsifer/infra/apps/fleetd/client"
	"github.com/jonpulsifer/infra/apps/fleetd/fleetboot"
	"github.com/jonpulsifer/infra/apps/fleetd/protocol"
)

const (
	tpmDevice = "/dev/tpmrm0"
	eventLog  = "/sys/kernel/security/tpm0/binary_bios_measurements"
	efiVars   = "/sys/firmware/efi/efivars"
	// ramDir holds the download and the mounts, on a tmpfs of its own.
	ramDir = "/run/fleet-boot"
)

func main() {
	cmdline := client.ReadTrim("/proc/cmdline")
	log := newLogger(cmdlineValue(cmdline, "syslog_host"))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	if err := run(ctx, log, cmdlineValue(cmdline, "fleet_attest_url"), cmdlineValue(cmdline, "fleet_ntp_server")); err != nil {
		log.Printf("FAILED: %v", err)
	}
	log.Printf("waiting; this boot does nothing more")
	<-ctx.Done()
}

func run(ctx context.Context, log *logger, url, ntp string) error {
	if url == "" {
		return errors.New("the command line names no fleet_attest_url; this boot does not attest")
	}
	if err := mountSecurityfs(); err != nil {
		return fmt.Errorf("mount securityfs: %w", err)
	}
	macs, err := bootMACs(ctx, efiVars, time.Minute)
	if err != nil {
		return err
	}
	// The clock waits for the route the NTP server is reached over.
	setClock(ntp, log)
	rw, err := openTPM(ctx, 30*time.Second)
	if err != nil {
		return err
	}
	defer rw.Close()
	evlog, err := os.ReadFile(eventLog)
	if err != nil {
		return fmt.Errorf("event log: %w", err)
	}
	serial, uuid := client.ReadTrim("/sys/class/dmi/id/product_serial"), client.ReadTrim("/sys/class/dmi/id/product_uuid")
	if serial == "" {
		return errors.New("no SMBIOS serial")
	}
	httpc := &http.Client{Timeout: 2 * time.Minute}
	res, err := eachMAC(macs, log.Printf, func(mac string) (*client.Result, error) {
		m := client.LocalMachine(serial, uuid, mac)
		log.Printf("attesting serial %s mac %s against %s", m.Serial, m.MAC, url)
		// One LLDP listener serves every try with this MAC.
		network := once(client.Network(m.MAC, log.Printf))
		return attest(ctx, 5, 30*time.Second, log.Printf, func(ctx context.Context) (*client.Result, error) {
			ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
			defer cancel()
			return client.Run(ctx, rw, client.Config{
				BaseURL:  url,
				HTTP:     httpc,
				Machine:  m,
				EventLog: evlog,
				StoreNV:  true,
				Logf:     log.Printf,
				Network:  network,
			})
		})
	})
	if err != nil {
		return err
	}
	log.Printf("PASSED: LDevID and LAK issued; NV %x", res.NVIndexes)
	b := &client.Boot{BaseURL: url, HTTP: httpc, TPM: rw, Session: res.Session}
	r, err := askRun(ctx, b, 5, 10*time.Second, log.Printf)
	if err != nil {
		return err
	}
	if r.Run == "" {
		log.Printf("fleetd holds no run for this boot")
		return nil
	}
	log.Printf("run %s: %s", r.Run, r.Action)
	free, err := mountRAM(ramDir)
	if err != nil {
		return fmt.Errorf("mount the RAM directory: %w", err)
	}
	meminfo, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return err
	}
	budget, err := fleetboot.MemoryBudget(meminfo, free)
	if err != nil {
		return err
	}
	e := &fleetboot.Executor{
		Host:        fleetboot.LinuxHost{},
		Reporter:    b,
		HTTP:        &http.Client{},
		Logf:        log.Printf,
		Sys:         "/sys",
		Dev:         "/dev",
		EFIVars:     "/sys/firmware/efi/efivars",
		RAM:         ramDir,
		UUID:        strings.ToLower(uuid),
		Code:        res.InstallCode,
		MaxImage:    budget,
		EraseBudget: 780 * time.Second,
		RebootDelay: 10 * time.Second,
	}
	return e.Run(ctx, r)
}

// attest runs the attestation until it passes, fleetd gives a verdict, or
// tries runs fail, with pause between them. A verdict is fleetd refusing
// the machine (400) or failing its evidence (403), which another try of the
// same boot gets again.
func attest(ctx context.Context, tries int, pause time.Duration, logf func(string, ...any), once func(context.Context) (*client.Result, error)) (*client.Result, error) {
	var err error
	for try := 1; try <= tries; try++ {
		var res *client.Result
		if res, err = once(ctx); err == nil {
			return res, nil
		}
		var refused *client.RefusedError
		if errors.As(err, &refused) && (refused.Status == http.StatusBadRequest || refused.Status == http.StatusForbidden) {
			return nil, fmt.Errorf("fleetd gave a verdict: %w", err)
		}
		logf("try %d failed: %v", try, err)
		if try < tries {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(pause):
			}
		}
	}
	return nil, fmt.Errorf("the machine did not attest in %d tries: %w", tries, err)
}

// eachMAC attests with each candidate boot MAC in turn while fleetd refuses
// the claim (400), which a MAC NetBox does not hold for the serial draws, and
// stops at a pass or any other answer.
func eachMAC(macs []string, logf func(string, ...any), try func(mac string) (*client.Result, error)) (*client.Result, error) {
	var err error
	for _, mac := range macs {
		var res *client.Result
		if res, err = try(mac); err == nil {
			return res, nil
		}
		var refused *client.RefusedError
		if !errors.As(err, &refused) || refused.Status != http.StatusBadRequest {
			return nil, err
		}
		logf("fleetd refused the claim with mac %s; trying the next NIC", mac)
	}
	return nil, err
}

// once answers what f answered the first time, as often as it is asked.
func once[T any](f func() T) func() T {
	var v T
	var o sync.Once
	return func() T {
		o.Do(func() { v = f() })
		return v
	}
}

// runAsker is the run request of a passed session.
type runAsker interface {
	Run(context.Context) (protocol.BootRun, error)
}

// askRun asks fleetd for the boot's run, trying again on an outage. A
// fleetd that serves no run for the session answers an empty one.
func askRun(ctx context.Context, b runAsker, tries int, pause time.Duration, logf func(string, ...any)) (protocol.BootRun, error) {
	var err error
	for try := 1; try <= tries; try++ {
		var r protocol.BootRun
		if r, err = b.Run(ctx); err == nil {
			return r, nil
		}
		if errors.Is(err, client.ErrNoBoot) {
			logf("%v", err)
			return protocol.BootRun{}, nil
		}
		logf("asking for the run failed (try %d): %v", try, err)
		if try < tries {
			select {
			case <-ctx.Done():
				return protocol.BootRun{}, ctx.Err()
			case <-time.After(pause):
			}
		}
	}
	return protocol.BootRun{}, fmt.Errorf("fleetd did not answer the run request: %w", err)
}

// openTPM waits for the TPM's resource manager, which appears once the
// TPM's driver has probed.
func openTPM(ctx context.Context, wait time.Duration) (interface {
	Read([]byte) (int, error)
	Write([]byte) (int, error)
	Close() error
}, error) {
	deadline := time.Now().Add(wait)
	for {
		rw, err := tpm2.OpenTPM(tpmDevice)
		if err == nil {
			return rw, nil
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("open %s: %w", tpmDevice, err)
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}
