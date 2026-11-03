package fleetboot

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/jonpulsifer/infra/apps/fleetd/protocol"
)

// FleetOSEntries names the boot entries the fleet's OSes create, as a
// regular expression: the Talos installer's, the Ubuntu and Debian
// installers', and next-boot's own "fleet <os>" entry for an image.
// next-boot keeps the one on this install's EFI system partition and
// deletes the others; entries of no fleet OS stay.
const FleetOSEntries = `Talos Linux UKI|Ubuntu|debian|fleet .*`

var fleetOSEntry = regexp.MustCompile(`^(` + FleetOSEntries + `)(\s|$)`)

// BootEntry is one Boot#### variable as efibootmgr -v prints it.
type BootEntry struct {
	Num    string
	Active bool
	Label  string
	Path   string
}

// BootVars is efibootmgr -v's view of the firmware's boot variables.
type BootVars struct {
	Next    string
	Order   []string
	Entries []BootEntry
}

var bootLine = regexp.MustCompile(`^Boot([0-9A-Fa-f]{4})(\*?) (.*)$`)

// ParseBootVars reads efibootmgr's output. A label ends at the tab before
// the device path.
func ParseBootVars(out []byte) BootVars {
	var v BootVars
	s := bufio.NewScanner(bytes.NewReader(out))
	for s.Scan() {
		line := s.Text()
		switch {
		case strings.HasPrefix(line, "BootNext: "):
			v.Next = strings.TrimSpace(strings.TrimPrefix(line, "BootNext: "))
		case strings.HasPrefix(line, "BootOrder: "):
			for _, n := range strings.Split(strings.TrimSpace(strings.TrimPrefix(line, "BootOrder: ")), ",") {
				if n != "" {
					v.Order = append(v.Order, strings.ToUpper(n))
				}
			}
		default:
			m := bootLine.FindStringSubmatch(line)
			if m == nil {
				continue
			}
			label, path, _ := strings.Cut(m[3], "\t")
			v.Entries = append(v.Entries, BootEntry{Num: strings.ToUpper(m[1]), Active: m[2] == "*", Label: strings.TrimSpace(label), Path: path})
		}
	}
	return v
}

// ForESP is the first entry whose device path names partition n of GUID
// guid.
func (v BootVars) ForESP(n int, guid string) (BootEntry, bool) {
	needle := strings.ToLower(fmt.Sprintf("HD(%d,GPT,%s,", n, guid))
	for _, e := range v.Entries {
		if strings.Contains(strings.ToLower(e.Path), needle) || strings.Contains(strings.ToLower(e.Label), needle) {
			return e, true
		}
	}
	return BootEntry{}, false
}

// Stale are the fleet OS entries that do not name the partition GUID keep;
// with keep empty, every fleet OS entry.
func (v BootVars) Stale(keep string) []BootEntry {
	var out []BootEntry
	for _, e := range v.Entries {
		if !fleetOSEntry.MatchString(e.Label) {
			continue
		}
		if keep != "" && strings.Contains(strings.ToLower(e.Label+e.Path), strings.ToLower(keep)) {
			continue
		}
		out = append(out, e)
	}
	return out
}

// IPv4 is the first entry that boots IPv4 from the network.
func (v BootVars) IPv4() (BootEntry, bool) {
	for _, e := range v.Entries {
		if strings.Contains(strings.ToUpper(e.Label+e.Path), "IPV4") {
			return e, true
		}
	}
	return BootEntry{}, false
}

// OrderWithFirst is BootOrder with n first, the rest in their order, and
// any number with no entry dropped.
func (v BootVars) OrderWithFirst(n string) []string {
	exists := map[string]bool{}
	for _, e := range v.Entries {
		exists[e.Num] = true
	}
	out := []string{strings.ToUpper(n)}
	for _, o := range v.Order {
		if !strings.EqualFold(o, n) && exists[o] {
			out = append(out, o)
		}
	}
	return out
}

// nextBoot makes the next boot certain: after an install the disk boots,
// through its entry on this install's EFI system partition, created when
// none names it; after a wipe with no install, the network. The entry goes
// first in BootOrder and is BootNext, and each is read back. Every other
// fleet OS entry names a partition this run erased or another disk's, and
// goes. A retired node powers off, so its next-boot only deletes them, and
// a failure there is logged and does not stop the power-off. A run that
// only attests leaves the boot order alone.
func (e *Executor) nextBoot(ctx context.Context, r protocol.BootRun) (string, error) {
	if !r.Install && !r.Wipe {
		return "nothing installed or wiped; the firmware's boot order decides the next boot", nil
	}
	fail := func(format string, args ...any) (string, error) {
		msg := fmt.Sprintf(format, args...)
		if r.Retire {
			return msg + "; the retired node powers off with its boot entries as they are", nil
		}
		return "", fmt.Errorf("%s; the run fails, and the node stays in fleet-boot", msg)
	}
	e.mountEFIVars()
	efibootmgr := func(args ...string) ([]byte, error) {
		out, err := e.Host.Run(ctx, "efibootmgr", args...)
		if err != nil {
			return out, fmt.Errorf("%v: %s", err, strings.TrimSpace(string(out)))
		}
		return out, nil
	}
	out, err := efibootmgr("-v")
	if err != nil {
		return fail("efibootmgr failed (%v)", err)
	}
	vars := ParseBootVars(out)
	guid := ""
	var target BootEntry
	if r.Install {
		d, err := e.checkDisk(r.Disk, r.DiskSerial, "no boot entry set")
		if err != nil {
			return fail("%v", err)
		}
		f, err := os.Open(d.Path)
		if err != nil {
			return fail("open %s: %v", d.Path, err)
		}
		g, err := ReadGPT(f, d.SectorSize)
		f.Close()
		if err != nil {
			return fail("%s's GPT: %v", d.Path, err)
		}
		esp, ok := g.OfType(TypeESP)
		if !ok {
			return fail("%s has no EFI system partition", d.Path)
		}
		guid = esp.GUID
		if target, ok = vars.ForESP(esp.Number, guid); !ok {
			label := "fleet " + r.OS
			if r.OS == "" {
				label = "fleet image"
			}
			if _, err := efibootmgr("-q", "-c", "-d", d.Path, "-p", strconv.Itoa(esp.Number), "-L", label, "-l", `\EFI\BOOT\BOOTX64.EFI`); err != nil {
				return fail("the boot entry for %s's EFI system partition cannot be created (%v)", d.Path, err)
			}
			if out, err = efibootmgr("-v"); err != nil {
				return fail("efibootmgr failed (%v)", err)
			}
			vars = ParseBootVars(out)
			if target, ok = vars.ForESP(esp.Number, guid); !ok {
				return fail("no boot entry names %s's EFI system partition (%s) after creating one", d.Path, guid)
			}
			e.logf("created Boot%s for %s's EFI system partition", target.Num, d.Path)
		}
	}
	for _, s := range vars.Stale(guid) {
		if _, err := efibootmgr("-q", "-b", s.Num, "-B"); err != nil {
			return fail("the stale entry Boot%s cannot be deleted (%v)", s.Num, err)
		}
		e.logf("deleted the stale entry Boot%s", s.Num)
	}
	if r.Retire {
		return "a retired node powers off; no next boot", nil
	}
	what := "the installed disk"
	if !r.Install {
		var ok bool
		if target, ok = vars.IPv4(); !ok {
			return fail("no IPv4 network boot entry")
		}
		what = "IPv4 network"
	}
	if out, err = efibootmgr("-v"); err != nil {
		return fail("efibootmgr failed (%v)", err)
	}
	order := ParseBootVars(out).OrderWithFirst(target.Num)
	if _, err := efibootmgr("-q", "-o", strings.Join(order, ",")); err != nil {
		return fail("BootOrder refused (%v)", err)
	}
	if _, err := efibootmgr("-q", "-n", target.Num); err != nil {
		return fail("BootNext refused (%v)", err)
	}
	if out, err = efibootmgr(); err != nil {
		return fail("efibootmgr failed (%v)", err)
	}
	now := ParseBootVars(out)
	if !strings.EqualFold(now.Next, target.Num) {
		return fail("BootNext reads back as %q, not %s", now.Next, target.Num)
	}
	if len(now.Order) == 0 || !strings.EqualFold(now.Order[0], target.Num) {
		return fail("BootOrder reads back as %q, not %s first", strings.Join(now.Order, ","), target.Num)
	}
	return fmt.Sprintf("Boot%s (%s) is the next boot and first in BootOrder (%s)", target.Num, what, strings.Join(now.Order, ",")), nil
}
