package main

import (
	"context"
	"strconv"
	"strings"
)

// PBX is the folly office phone: the four SPA504G lines, the voip.ms trunk
// each one dials out on, and whether a call is live right now. Prometheus
// scrapes Asterisk as job "pbx-metrics" in the pbx namespace
// (clusters/folly/monitoring/pbx-rules.yaml has the alert on the same
// series); when the exporter is unreachable every query below returns no
// samples, so an absent PBX renders as every line off rather than an error.
type PBX struct {
	Lines []PhoneLine `json:"lines"`
	OnAir bool        `json:"on_air"`
}

// PhoneLine is one of the four SPA504G lines. Handset is the line's own
// registration to the PBX (asterisk_endpoints_state); Trunk is the voip.ms
// sub-account it dials out on (asterisk_pjsip_outbound_registration_status).
// The two use different "good" values on the wire, both normalized here to
// registered/not.
type PhoneLine struct {
	Line    int  `json:"line"`
	Handset bool `json:"handset"`
	Trunk   bool `json:"trunk"`
}

const (
	// asterisk_endpoints_state: 0 unknown, 1 offline, 2 online.
	queryPBXEndpoints = `asterisk_endpoints_state{namespace="pbx", resource=~"line[1-4]"}`
	// asterisk_pjsip_outbound_registration_status: 0 unregistered, 1 registered, 2 rejected.
	queryPBXTrunks = `asterisk_pjsip_outbound_registration_status{namespace="pbx"}`
	// Current call count, a gauge (unlike asterisk_calls_sum, a running total).
	queryPBXCalls = `asterisk_calls_count{namespace="pbx"}`
)

// lineSubAccount maps each handset line to the voip.ms sub-account it dials
// out on (docs/runbooks/operate-the-office-phone.md).
var lineSubAccount = map[int]string{
	1: "168847_cathy",
	2: "168847_recorded",
	3: "168847_sandbox",
	4: "168847_1994",
}

// collectPBX fails only when the endpoint query itself errors; an empty
// result (no PBX namespace scraped at all) is a healthy "everything off".
func collectPBX(ctx context.Context, src promSource) (*PBX, error) {
	endpoints, err := src.Query(ctx, queryPBXEndpoints)
	if err != nil {
		return nil, err
	}
	trunks, _ := src.Query(ctx, queryPBXTrunks)
	calls, _ := src.Query(ctx, queryPBXCalls)

	handsetOnline := map[int]bool{}
	for _, sm := range endpoints {
		n := lineNumber(sm.Metric["resource"])
		if n == 0 {
			continue
		}
		handsetOnline[n] = sm.Value == 2
	}

	trunkRegistered := map[string]bool{}
	for _, sm := range trunks {
		acct := subAccount(sm.Metric["username"])
		if acct == "" {
			continue
		}
		trunkRegistered[acct] = sm.Value == 1
	}

	lines := make([]PhoneLine, 4)
	for i := 1; i <= 4; i++ {
		lines[i-1] = PhoneLine{
			Line:    i,
			Handset: handsetOnline[i],
			Trunk:   trunkRegistered[lineSubAccount[i]],
		}
	}

	onAir := false
	for _, sm := range calls {
		if sm.Value > 0 {
			onAir = true
			break
		}
	}

	return &PBX{Lines: lines, OnAir: onAir}, nil
}

// lineNumber parses the endpoint's "resource" label, "line3" -> 3, else 0.
func lineNumber(resource string) int {
	rest, ok := strings.CutPrefix(resource, "line")
	if !ok {
		return 0
	}
	n, err := strconv.Atoi(rest)
	if err != nil {
		return 0
	}
	return n
}

// subAccount parses the registration's "username" label,
// "sip:168847_cathy@montreal10.voip.ms" -> "168847_cathy".
func subAccount(username string) string {
	rest, ok := strings.CutPrefix(username, "sip:")
	if !ok {
		return ""
	}
	acct, _, _ := strings.Cut(rest, "@")
	return acct
}
