// tink-attest is the Tinkerbell action that attests a machine against
// talos-attest from inside HookOS: it reads the machine's SMBIOS identity and
// event log, drives the flow with the TPM, and stores the issued
// certificates in NV. It exits non-zero on any refusal, so the Workflow
// fails and the machine stays where it is.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/google/go-tpm/legacy/tpm2"

	"github.com/jonpulsifer/infra/apps/talos-attest/client"
	"github.com/jonpulsifer/infra/apps/talos-attest/protocol"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func readTrim(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// logf writes to stdout, which tink-agent ships to syslog, and to the
// consoles, where the owner watches the machine.
func logf(format string, args ...any) {
	line := "attest: " + fmt.Sprintf(format, args...) + "\n"
	os.Stdout.WriteString(line)
	for _, tty := range []string{"/dev/tty0", "/dev/ttyS0"} {
		if f, err := os.OpenFile(tty, os.O_WRONLY, 0); err == nil {
			f.WriteString(line)
			f.Close()
		}
	}
}

func main() {
	url := flag.String("url", env("ATTEST_URL", ""), "talos-attest base URL")
	device := flag.String("tpm", env("TPM_DEVICE", "/dev/tpmrm0"), "TPM resource manager device")
	eventLog := flag.String("event-log", env("EVENT_LOG", "/sys/kernel/security/tpm0/binary_bios_measurements"), "TCG event log")
	mac := flag.String("mac", env("MAC", ""), "MAC of the NIC the machine booted from")
	serial := flag.String("serial", env("SERIAL", readTrim("/sys/class/dmi/id/product_serial")), "SMBIOS serial")
	uuid := flag.String("uuid", env("UUID", readTrim("/sys/class/dmi/id/product_uuid")), "SMBIOS UUID")
	storeNV := flag.Bool("store-nv", env("STORE_NV", "true") == "true", "store the certificates in TPM NV")
	timeout := flag.Duration("timeout", 10*time.Minute, "give up after this long")
	flag.Parse()

	if err := run(*url, *device, *eventLog, protocol.Machine{Serial: *serial, UUID: *uuid, MAC: *mac, Hostname: readTrim("/proc/sys/kernel/hostname")}, *storeNV, *timeout); err != nil {
		logf("FAILED: %v", err)
		os.Exit(1)
	}
}

func run(url, device, eventLog string, m protocol.Machine, storeNV bool, timeout time.Duration) error {
	if url == "" {
		return errors.New("ATTEST_URL is required")
	}
	if m.Serial == "" {
		return errors.New("no SMBIOS serial; run as root or set SERIAL")
	}
	log, err := os.ReadFile(eventLog)
	if err != nil {
		return fmt.Errorf("event log: %w", err)
	}
	rw, err := tpm2.OpenTPM(device)
	if err != nil {
		return fmt.Errorf("open %s: %w", device, err)
	}
	defer rw.Close()

	logf("attesting serial %s mac %s against %s", m.Serial, m.MAC, url)
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	res, err := client.Run(ctx, rw, client.Config{
		BaseURL:  url,
		HTTP:     &http.Client{Timeout: 2 * time.Minute},
		Machine:  m,
		EventLog: log,
		StoreNV:  storeNV,
		Logf:     logf,
	})
	if err != nil {
		return err
	}
	logf("PASSED: LDevID and LAK issued; NV %x", res.NVIndexes)
	return nil
}
