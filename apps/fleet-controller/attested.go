package main

import (
	"net/netip"
	"time"
)

// Attested is where talos-attest recorded the machine plugged in at its
// last intake pass, from facts the session's AK signed: the boot NIC's
// address, the switch's LLDP chassis ID and port ID, and when. These are the
// only network facts the controller acts on.
type Attested struct {
	Address string
	Switch  string
	Port    string
	At      time.Time
}

const (
	// AttestedAddressTTL bounds how old an attested bootstrap address may be
	// for a new run's Machine. The bootstrap network leases for a minute, so
	// an older address may be another machine's by now.
	AttestedAddressTTL = 15 * time.Minute
	// AttestedPortTTL bounds how old an attested port may be to cable a node
	// after its binding.
	AttestedPortTTL = time.Hour
	// BMCAddressAnnotation on a Workflow pins the address its Machine dials
	// for as long as the run is unfinished.
	BMCAddressAnnotation = "lolwtf.ca/bmc-address"
)

// fresh says whether a time an anchor recorded is younger than ttl. A
// minute ahead of this clock is skew between anchors; more is no record.
func fresh(at, now time.Time, ttl time.Duration) bool {
	return !at.IsZero() && at.Sub(now) < time.Minute && now.Sub(at) < ttl
}

// bootstrapAddress says whether an address may be a machine's on the
// bootstrap network: an IPv4 host address inside the bootstrap prefix that
// no anchor or boot VIP holds.
func (c Config) bootstrapAddress(s string) bool {
	a, err := netip.ParseAddr(s)
	p := c.BootstrapPrefix
	if err != nil || !a.Is4() || !p.IsValid() || !p.Contains(a) || c.BootstrapReserved[a.String()] {
		return false
	}
	return hostAddress(p, a)
}

// bootstrapBMC points an AMT device's Machine at its bootstrap address. An
// unfinished run keeps the address its Workflow pinned, whatever its age, so
// Rufio never loses the Machine mid-run, and the pin tracks the lease: a pass
// during the run from another bootstrap address moves the Machine there, and
// one from anywhere else, such as the device's own Kubernetes address once
// its RADIUS user moves it, ends the pin. A finished run ends it too.
// Otherwise a planned or staged device without oob_ip, which may still sit on
// the bootstrap network where its Kubernetes address means nothing, takes
// the address its last intake pass attested, when that is younger than
// AttestedAddressTTL and a bootstrap host address. AMT shares the host's NIC
// and address.
func (c Config) bootstrapBMC(d Device, workflows []Object, now time.Time) Device {
	if d.BMCType != "amt" || d.OOBAddress != "" {
		return d
	}
	for _, wf := range workflows {
		a := wf.annotation(BMCAddressAnnotation)
		if a == "" || Finished(wf.State()) {
			continue
		}
		if created := wf.Created(); !created.IsZero() && !d.Attested.At.Before(created) && d.Attested.Address != a {
			if !c.bootstrapAddress(d.Attested.Address) {
				return d
			}
			a = d.Attested.Address
		}
		d.BMCAddress, d.BootstrapBMC = a, true
		return d
	}
	if d.Status != "planned" && d.Status != "staged" {
		return d
	}
	if !fresh(d.Attested.At, now, AttestedAddressTTL) || !c.bootstrapAddress(d.Attested.Address) {
		return d
	}
	d.BMCAddress, d.BootstrapBMC = d.Attested.Address, true
	return d
}
