package jcs

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// formatNumber renders a float64 the way ECMAScript's Number::toString does,
// which is what RFC 8785 section 3.2.2.3 requires. Go's own %v is close but not
// the same: it switches to exponent notation at different magnitudes and spells
// the exponent differently, so a transcript formatted by strconv alone would
// canonicalise differently from every JavaScript verifier.
//
// The algorithm is ECMA-262's, transcribed. Given the shortest round-tripping
// decimal digits s of k digits and an exponent n such that the value is
// s x 10^(n-k), the notation is chosen by where n sits relative to 0, k and 21.
func formatNumber(v float64) (string, error) {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return "", fmt.Errorf("jcs: %v is not representable in JSON", v)
	}
	// Negative zero prints as "0": ECMAScript's ToString maps -0 to "0", and
	// a canonical form that distinguished them would sign bytes that compare
	// equal as numbers.
	if v == 0 {
		return "0", nil
	}
	sign := ""
	if v < 0 {
		sign = "-"
		v = -v
	}
	// 'e' with precision -1 is the shortest representation that round-trips,
	// which is exactly ECMAScript's "k is as small as possible" condition.
	shortest := strconv.FormatFloat(v, 'e', -1, 64)
	mantissa, expPart, ok := strings.Cut(shortest, "e")
	if !ok {
		return "", fmt.Errorf("jcs: cannot decompose %s", shortest)
	}
	exp, err := strconv.Atoi(expPart)
	if err != nil {
		return "", err
	}
	digits := strings.Replace(mantissa, ".", "", 1)
	k := len(digits)
	n := exp + 1

	switch {
	case k <= n && n <= 21:
		return sign + digits + strings.Repeat("0", n-k), nil
	case 0 < n && n <= 21:
		return sign + digits[:n] + "." + digits[n:], nil
	case -6 < n && n <= 0:
		return sign + "0." + strings.Repeat("0", -n) + digits, nil
	}
	e := n - 1
	esign := "+"
	if e < 0 {
		esign = "-"
		e = -e
	}
	if k == 1 {
		return sign + digits + "e" + esign + strconv.Itoa(e), nil
	}
	return sign + digits[:1] + "." + digits[1:] + "e" + esign + strconv.Itoa(e), nil
}
