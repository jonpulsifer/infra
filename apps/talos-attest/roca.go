package main

import "math/big"

// rocaPrimes are the small primes of the ROCA fingerprint (CVE-2017-15361).
// Infineon's flawed RSALib built every modulus as k*M + (65537^a mod M), with M
// the primorial of these primes, so each residue N mod p sits in the subgroup
// that 65537 generates mod p. A random modulus passes all 38 tests with
// negligible probability.
var rocaPrimes = []int64{
	3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71,
	73, 79, 83, 89, 97, 101, 103, 107, 109, 113, 127, 131, 137, 139, 149, 151,
	157, 163, 167,
}

var rocaSubgroups = func() []map[int64]bool {
	groups := make([]map[int64]bool, len(rocaPrimes))
	for i, p := range rocaPrimes {
		g := map[int64]bool{}
		for v := int64(1); !g[v]; v = v * (65537 % p) % p {
			g[v] = true
		}
		groups[i] = g
	}
	return groups
}()

// rocaVulnerable reports whether an RSA modulus carries the ROCA fingerprint.
func rocaVulnerable(n *big.Int) bool {
	var r big.Int
	for i, p := range rocaPrimes {
		if !rocaSubgroups[i][r.Mod(n, big.NewInt(p)).Int64()] {
			return false
		}
	}
	return true
}
