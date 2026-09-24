package jcs

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// formatNumber renders a float64 as ECMAScript's Number::toString, as RFC 8785
// requires. strconv picks exponent notation at other magnitudes and spells it differently.
func formatNumber(v float64) (string, error) {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return "", fmt.Errorf("jcs: %v is not representable in JSON", v)
	}
	// ECMAScript's ToString maps -0 to "0".
	if v == 0 {
		return "0", nil
	}
	sign := ""
	if v < 0 {
		sign = "-"
		v = -v
	}
	// Precision -1 gives the shortest round-tripping digits: ECMAScript's smallest k.
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

	// ECMA-262 picks the notation from n against 0, k and 21, where the value is
	// digits x 10^(n-k).
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
