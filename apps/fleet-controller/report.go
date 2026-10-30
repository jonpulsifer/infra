package main

import (
	"fmt"
	"net/netip"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// LLDP is the switch port an intake reports, from the LLDP frame the switch
// sent the machine's boot NIC: the switch's chassis ID (its MAC on a UniFi
// switch) and system name, and the port's ID ("Port <n>") and description
// (the port's name).
type LLDP struct {
	ChassisID       string `json:"chassis_id"`
	PortID          string `json:"port_id"`
	PortDescription string `json:"port_description"`
	SystemName      string `json:"system_name"`
}

// valid says whether a switch's report is usable: a chassis ID and a port ID,
// and nothing but printable ASCII of at most 255 characters.
func (l LLDP) valid() bool {
	if l.ChassisID == "" || l.PortID == "" {
		return false
	}
	for _, s := range []string{l.ChassisID, l.PortID, l.PortDescription, l.SystemName} {
		if !printable(s, 255) {
			return false
		}
	}
	return true
}

var portName = regexp.MustCompile(`^(?i:port) ?([1-9][0-9]{0,3})$`)

// portNumber is the switch port an LLDP port ID names as "Port <n>".
func portNumber(portID string) (int, bool) {
	m := portName.FindStringSubmatch(strings.TrimSpace(portID))
	if m == nil {
		return 0, false
	}
	n, _ := strconv.Atoi(m[1])
	return n, true
}

// plain strips what NetBox's journal would render as Markdown, and control
// characters, from text a machine or a switch supplied, as talos-attest's
// plain does.
func plain(s string) string {
	return strings.TrimSpace(strings.Map(func(r rune) rune {
		if r < ' ' || r == 0x7f || strings.ContainsRune("*_`#[]()<>|~\\", r) {
			return ' '
		}
		return r
	}, s))
}

// Annotations on a Hardware: what the machine's latest intake reported. The
// intake is unauthenticated, so they are diagnostics only: no Machine, cable
// or port check follows from them. The controller writes them with a merge
// patch under its own field manager, so a pass's apply of the Hardware leaves
// them alone.
const (
	ReportedAtAnnotation      = "lolwtf.ca/intake-at"
	ReportedAddressAnnotation = "lolwtf.ca/intake-address"
	LLDPChassisAnnotation     = "lolwtf.ca/lldp-chassis-id"
	LLDPPortAnnotation        = "lolwtf.ca/lldp-port-id"
	LLDPPortDescAnnotation    = "lolwtf.ca/lldp-port-description"
	LLDPSystemAnnotation      = "lolwtf.ca/lldp-system-name"
)

// Report is what one intake claimed beyond its identity: when, the address
// it came from, its serial, and its switch port.
type Report struct {
	At      time.Time
	Address string
	Serial  string
	LLDP    *LLDP
}

// annotations is the merge patch of a report: a field it lacks is removed,
// so a Hardware never keeps an older intake's port.
func (rep Report) annotations() map[string]any {
	a := map[string]any{
		ReportedAtAnnotation:      rep.At.UTC().Format(time.RFC3339),
		ReportedAddressAnnotation: nil,
		SerialAnnotation:          rep.Serial,
		LLDPChassisAnnotation:     nil,
		LLDPPortAnnotation:        nil,
		LLDPPortDescAnnotation:    nil,
		LLDPSystemAnnotation:      nil,
	}
	if rep.Address != "" {
		a[ReportedAddressAnnotation] = rep.Address
	}
	if l := rep.LLDP; l != nil {
		a[LLDPChassisAnnotation], a[LLDPPortAnnotation] = l.ChassisID, l.PortID
		a[LLDPPortDescAnnotation], a[LLDPSystemAnnotation] = l.PortDescription, l.SystemName
	}
	return a
}

// reportOf reads a Hardware's report; one with no time is none.
func reportOf(o Object) Report {
	at, _ := time.Parse(time.RFC3339, o.annotation(ReportedAtAnnotation))
	rep := Report{At: at, Serial: o.annotation(SerialAnnotation)}
	if a, err := netip.ParseAddr(o.annotation(ReportedAddressAnnotation)); err == nil {
		rep.Address = a.String()
	}
	l := LLDP{
		ChassisID:       o.annotation(LLDPChassisAnnotation),
		PortID:          o.annotation(LLDPPortAnnotation),
		PortDescription: o.annotation(LLDPPortDescAnnotation),
		SystemName:      o.annotation(LLDPSystemAnnotation),
	}
	if l.valid() {
		rep.LLDP = &l
	}
	return rep
}

// String says what the report holds, for an audit line.
func (rep Report) String() string {
	from := "from an unknown address"
	if rep.Address != "" {
		from = "from " + rep.Address
	}
	if rep.LLDP == nil {
		return from + ", no LLDP"
	}
	return fmt.Sprintf("%s, LLDP %q on %s (%s)", from, rep.LLDP.PortID, rep.LLDP.ChassisID, rep.LLDP.SystemName)
}
