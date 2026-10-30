package main

import (
	"net/netip"
	"testing"
	"time"
)

func TestPortNumber(t *testing.T) {
	for id, want := range map[string]int{"Port 7": 7, "port24": 24, " Port 12 ": 12, "eth4": 0, "f4:e2:c6:00:00:07": 0, "Port 0": 0, "Port 7a": 0} {
		if got, ok := portNumber(id); got != want || ok != (want != 0) {
			t.Errorf("portNumber(%q) = %d %v", id, got, ok)
		}
	}
}

func TestPlain(t *testing.T) {
	for in, want := range map[string]string{
		"Port 7":                        "Port 7",
		"Port 7 **[pwn](http://x)**":    "Port 7    pwn  http://x",
		"`rack`|\\x\n<img src=y>~~_a_#": "rack   x  img src=y    a",
	} {
		if got := plain(in); got != want {
			t.Errorf("plain(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestBootstrapAddress(t *testing.T) {
	c := Config{BootstrapPrefix: netip.MustParsePrefix("10.9.0.0/28"), BootstrapReserved: map[string]bool{"10.9.0.11": true, "10.9.0.14": true}}
	for a, want := range map[string]bool{
		"10.9.0.5": true, "10.9.0.11": false, "10.9.0.14": false, "10.9.0.0": false, "10.9.0.15": false,
		"10.9.0.16": false, "10.3.0.12": false, "2001:db8::1": false, "": false,
	} {
		if got := c.bootstrapAddress(a); got != want {
			t.Errorf("bootstrapAddress(%q) = %v", a, got)
		}
	}
	if (Config{}).bootstrapAddress("10.9.0.5") {
		t.Error("an address counts without a bootstrap prefix")
	}
}

func TestFresh(t *testing.T) {
	now := testNow
	for at, want := range map[time.Time]bool{
		now.Add(-time.Minute): true, now.Add(-AttestedAddressTTL): false, now.Add(10 * time.Second): true, now.Add(time.Minute): false, {}: false,
	} {
		if got := fresh(at, now, AttestedAddressTTL); got != want {
			t.Errorf("fresh(%s) = %v", at, got)
		}
	}
}
