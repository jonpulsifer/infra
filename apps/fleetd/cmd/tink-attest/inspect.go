package main

import (
	"flag"
	"fmt"
	"io"
	"strings"

	"github.com/google/go-tpm/legacy/tpm2"

	"github.com/jonpulsifer/infra/apps/fleetd/client"
)

// platform is the SMBIOS identity a qualification records.
type platform struct {
	vendor, model, sku, biosVendor, biosVersion, biosDate string
}

func readPlatform(dir string) platform {
	r := func(name string) string { return readTrim(dir + "/" + name) }
	return platform{r("sys_vendor"), r("product_name"), r("product_sku"), r("bios_vendor"), r("bios_version"), r("bios_date")}
}

// inspect prints what EK discovery finds on this machine and contacts no
// service. It writes no NV and makes no persistent object.
func inspect(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("inspect", flag.ContinueOnError)
	device := fs.String("tpm", env("TPM_DEVICE", "/dev/tpmrm0"), "TPM resource manager device")
	if err := fs.Parse(args); err != nil {
		return err
	}
	rw, err := tpm2.OpenTPM(*device)
	if err != nil {
		return fmt.Errorf("open %s: %w", *device, err)
	}
	defer rw.Close()
	r, err := client.Inspect(rw)
	if err != nil {
		return err
	}
	writeReport(out, readPlatform("/sys/class/dmi/id"), r)
	return nil
}

func writeReport(w io.Writer, p platform, r *client.TPMReport) {
	fmt.Fprintf(w, "model: %s %s (SKU %s)\n", p.vendor, p.model, p.sku)
	fmt.Fprintf(w, "firmware: %s %s (%s)\n", p.biosVendor, p.biosVersion, p.biosDate)
	fmt.Fprintf(w, "tpm: %s %q firmware %s, %s\n", r.Manufacturer, r.Vendor, r.Firmware, r.Spec)
	if r.IntakeErr != nil {
		fmt.Fprintf(w, "intake: FAILED: %v\n", r.IntakeErr)
	} else {
		sent := make([]string, len(r.Intake))
		for i, e := range r.Intake {
			c := "certified"
			if e.Cert == nil {
				c = "uncertified, admitted only by an approved pin"
			}
			sent[i] = fmt.Sprintf("%s %s (%s)", e.Alg, e.Hash, c)
		}
		fmt.Fprintf(w, "intake: sends %s\n", strings.Join(sent, ", "))
	}
	if r.IntakeNote != "" {
		fmt.Fprintf(w, "intake: %s\n", r.IntakeNote)
	}
	for _, pr := range r.Profiles {
		fmt.Fprintf(w, "ek %s (%s): certificate %s, template %s, nonce %s; ", pr.Alg, pr.Name, nvState(pr.Cert), nvState(pr.Template), nvState(pr.Nonce))
		switch {
		case pr.Err != nil:
			fmt.Fprintf(w, "FAILED: %v\n", pr.Err)
		case pr.EK.Cert != nil:
			fmt.Fprintf(w, "EK %s matches its certificate\n", pr.EK.Hash)
		default:
			fmt.Fprintf(w, "EK %s, uncertified\n", pr.EK.Hash)
		}
	}
	switch {
	case r.HighRangeErr != nil:
		fmt.Fprintf(w, "high range EK certificates: FAILED: %v\n", r.HighRangeErr)
	case len(r.HighRange) == 0:
		fmt.Fprintln(w, "high range EK certificates: none")
	default:
		idx := make([]string, len(r.HighRange))
		for i, h := range r.HighRange {
			idx[i] = fmt.Sprintf("%#x", h)
		}
		fmt.Fprintf(w, "high range EK certificates: %s (not used)\n", strings.Join(idx, ", "))
	}
}

func nvState(s client.NVState) string {
	switch {
	case s.Err != nil:
		return fmt.Sprintf("%#x unreadable (%v)", s.Index, s.Err)
	case s.Defined:
		return fmt.Sprintf("%#x present (%d bytes)", s.Index, s.Size)
	default:
		return fmt.Sprintf("%#x absent", s.Index)
	}
}
