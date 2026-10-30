package fleet

import "time"

// Attested is where fleetd recorded the machine plugged in at its
// last intake pass, from facts the session's AK signed: the switch's LLDP
// chassis ID and port ID, and when. These are the only network facts the
// controller acts on.
type Attested struct {
	Switch string
	Port   string
	At     time.Time
}

// AttestedPortTTL bounds how old an attested port may be to cable a node
// after its binding.
const AttestedPortTTL = time.Hour

// fresh says whether a time NetBox holds is younger than ttl. A minute
// ahead of this clock is skew; more is no record.
func fresh(at, now time.Time, ttl time.Duration) bool {
	return !at.IsZero() && at.Sub(now) < time.Minute && now.Sub(at) < ttl
}
