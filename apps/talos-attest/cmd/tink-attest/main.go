// tink-attest is the Tinkerbell action that attests a machine against
// talos-attest from inside HookOS: it reads the machine's SMBIOS identity and
// event log, drives the flow with the TPM, and stores the issued
// certificates in NV. With the host's network namespace it also reports the
// boot NIC's IPv4 address and the switch port its LLDP frame names, signed
// by the session's AK; the LLDP wait, at most 35 seconds, runs beside the
// TPM work. It exits non-zero on any refusal, so the Workflow
// fails and the machine stays where it is. An install code in the confirm's
// answer goes to -install-code for the install action; it is never logged.
//
// `tink-attest renew` runs on a running node instead. When the LDevID in NV
// expires within -renew-before, it has the service certify the LDevID key
// again on the strength of a LAK-signed quote, stores the new certificate in
// NV and restarts the pods -restart-selector picks on the node. When none is
// due, with -check (the default), it runs the daily check: the same LAK-signed
// quote and event log, which the service judges and records, and no new
// certificate. It exits 0 when the node has no LDevID.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/go-tpm/legacy/tpm2"

	"github.com/jonpulsifer/infra/apps/talos-attest/client"
	"github.com/jonpulsifer/infra/apps/talos-attest/lldp"
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
	if len(os.Args) > 1 && os.Args[1] == "renew" {
		if err := renew(os.Args[2:]); err != nil {
			printf("RENEWAL FAILED: %v", err)
			os.Exit(1)
		}
		return
	}
	url := flag.String("url", env("ATTEST_URL", ""), "talos-attest base URL")
	device := flag.String("tpm", env("TPM_DEVICE", "/dev/tpmrm0"), "TPM resource manager device")
	eventLog := flag.String("event-log", env("EVENT_LOG", "/sys/kernel/security/tpm0/binary_bios_measurements"), "TCG event log")
	mac := flag.String("mac", env("MAC", ""), "MAC of the NIC the machine booted from")
	serial := flag.String("serial", env("SERIAL", readTrim("/sys/class/dmi/id/product_serial")), "SMBIOS serial")
	uuid := flag.String("uuid", env("UUID", readTrim("/sys/class/dmi/id/product_uuid")), "SMBIOS UUID")
	storeNV := flag.Bool("store-nv", env("STORE_NV", "true") == "true", "store the certificates in TPM NV")
	installCode := flag.String("install-code", env("INSTALL_CODE_FILE", "/tmp/fleet/install_code"), "where to write the install code the service answers")
	timeout := flag.Duration("timeout", 10*time.Minute, "give up after this long")
	flag.Parse()

	// The SMBIOS facts fill the NetBox device the service creates on first sight.
	m := protocol.Machine{
		Serial:       *serial,
		UUID:         *uuid,
		MAC:          *mac,
		Hostname:     readTrim("/proc/sys/kernel/hostname"),
		Manufacturer: readTrim("/sys/class/dmi/id/sys_vendor"),
		Model:        readTrim("/sys/class/dmi/id/product_name"),
		SKU:          readTrim("/sys/class/dmi/id/product_sku"),
		BIOS:         readTrim("/sys/class/dmi/id/bios_version"),
	}
	if err := run(*url, *device, *eventLog, m, *storeNV, *installCode, *timeout, network(m.MAC)); err != nil {
		logf("FAILED: %v", err)
		os.Exit(1)
	}
}

// network starts listening on the NIC with the MAC and answers what it
// found when asked: the NIC's address, and the switch's LLDP neighbour when
// a frame arrived. A NIC the action cannot see, as without the host's
// network namespace, gives nothing.
func network(mac string) func() *protocol.Network {
	ifname := lldp.Interface("/sys", mac)
	if ifname == "" {
		logf("no NIC has the MAC %q; no network facts", mac)
		return func() *protocol.Network { return nil }
	}
	heard := make(chan *protocol.LLDP, 1)
	go func() {
		l, err := lldp.Listen(ifname, lldp.Wait)
		if err != nil {
			logf("no LLDP: %v", err)
			heard <- nil
			return
		}
		logf("LLDP on %s: %s port %q (%s)", ifname, l.ChassisID, l.PortID, l.SystemName)
		heard <- &l
	}()
	return func() *protocol.Network {
		n := &protocol.Network{LLDP: <-heard, Address: lldp.Address(ifname)}
		logf("network: %s address %q", ifname, n.Address)
		return n
	}
}

func run(url, device, eventLog string, m protocol.Machine, storeNV bool, installCode string, timeout time.Duration, net func() *protocol.Network) error {
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
		Network:  net,
	})
	if err != nil {
		return err
	}
	logf("PASSED: LDevID and LAK issued; NV %x", res.NVIndexes)
	if res.InstallCode == "" {
		logf("no install code in the answer")
		return removeInstallCode(installCode)
	}
	if err := writeInstallCode(installCode, res.InstallCode); err != nil {
		return fmt.Errorf("write the install code: %w", err)
	}
	logf("install code written to %s", installCode)
	return nil
}

// writeInstallCode leaves code in path, mode 0600, for the install action
// that follows. A directory it creates gets mode 0700; one that exists, such
// as the Template's mount, keeps its own. The rename keeps a reader from
// seeing half a code.
func writeInstallCode(path, code string) error {
	dir := filepath.Dir(path)
	if _, err := os.Stat(dir); errors.Is(err, fs.ErrNotExist) {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
		if err := os.Chmod(dir, 0o700); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".install_code-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err := f.WriteString(code); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}

// removeInstallCode drops a code an earlier run left, so an install never
// runs with a code no config waits behind.
func removeInstallCode(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("remove the stale install code: %w", err)
	}
	return nil
}
