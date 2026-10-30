package fleet

import (
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

func TestFresh(t *testing.T) {
	now := testNow
	for at, want := range map[time.Time]bool{
		now.Add(-time.Minute): true, now.Add(-AttestedPortTTL): false, now.Add(10 * time.Second): true, now.Add(time.Minute): false, {}: false,
	} {
		if got := fresh(at, now, AttestedPortTTL); got != want {
			t.Errorf("fresh(%s) = %v", at, got)
		}
	}
}
