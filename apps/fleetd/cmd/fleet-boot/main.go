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
	"syscall"
	"time"

	"github.com/google/go-tpm/legacy/tpm2"

	"github.com/jonpulsifer/infra/apps/fleetd/client"
	"github.com/jonpulsifer/infra/apps/fleetd/protocol"
)

const (
	tpmDevice = "/dev/tpmrm0"
	eventLog  = "/sys/kernel/security/tpm0/binary_bios_measurements"
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
	setClock(ntp, log)
	if err := mountSecurityfs(); err != nil {
		return fmt.Errorf("mount securityfs: %w", err)
	}
	mac, err := bootMAC(time.Minute)
	if err != nil {
		return err
	}
	rw, err := openTPM(30 * time.Second)
	if err != nil {
		return err
	}
	defer rw.Close()
	evlog, err := os.ReadFile(eventLog)
	if err != nil {
		return fmt.Errorf("event log: %w", err)
	}
	m := client.LocalMachine(client.ReadTrim("/sys/class/dmi/id/product_serial"), client.ReadTrim("/sys/class/dmi/id/product_uuid"), mac)
	if m.Serial == "" {
		return errors.New("no SMBIOS serial")
	}
	log.Printf("attesting serial %s mac %s against %s", m.Serial, m.MAC, url)
	httpc := &http.Client{Timeout: 2 * time.Minute}
	res, err := attest(ctx, 5, 30*time.Second, log.Printf, func(ctx context.Context) (*client.Result, error) {
		ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
		defer cancel()
		return client.Run(ctx, rw, client.Config{
			BaseURL:  url,
			HTTP:     httpc,
			Machine:  m,
			EventLog: evlog,
			StoreNV:  true,
			Logf:     log.Printf,
			Network:  client.Network(m.MAC, log.Printf),
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
	return execute(ctx, log.Printf, r)
}

// execute takes the run fleetd answered.
func execute(_ context.Context, logf func(string, ...any), r protocol.BootRun) error {
	if r.Run == "" {
		logf("fleetd holds no run for this boot")
		return nil
	}
	logf("run %s (%s): this fleet-boot runs no steps, so the run goes no further", r.Run, r.Action)
	return nil
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
func openTPM(wait time.Duration) (interface {
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
		time.Sleep(2 * time.Second)
	}
}
