package fleet

import "time"

// AttestedPortTTL bounds how old an attested port may be to cable a node
// after its binding.
const AttestedPortTTL = time.Hour

// fresh says whether a time NetBox holds is younger than ttl. A minute
// ahead of this clock is skew; more is no record.
func fresh(at, now time.Time, ttl time.Duration) bool {
	return !at.IsZero() && at.Sub(now) < time.Minute && now.Sub(at) < ttl
}
