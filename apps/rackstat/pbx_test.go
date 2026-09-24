package main

import (
	"context"
	"fmt"
	"testing"
)

func TestLineNumber(t *testing.T) {
	cases := []struct {
		resource string
		want     int
	}{
		{"line1", 1},
		{"line4", 4},
		{"vms-cathy", 0},
		{"", 0},
	}
	for _, c := range cases {
		if got := lineNumber(c.resource); got != c.want {
			t.Errorf("lineNumber(%q) = %d, want %d", c.resource, got, c.want)
		}
	}
}

func TestSubAccount(t *testing.T) {
	cases := []struct {
		username string
		want     string
	}{
		{"sip:168847_cathy@montreal10.voip.ms", "168847_cathy"},
		{"sip:168847_1994@montreal10.voip.ms", "168847_1994"},
		{"not-a-uri", ""},
		{"", ""},
	}
	for _, c := range cases {
		if got := subAccount(c.username); got != c.want {
			t.Errorf("subAccount(%q) = %q, want %q", c.username, got, c.want)
		}
	}
}

func TestCollectPBXAllOnline(t *testing.T) {
	src := &cannedProm{
		vec: map[string][]promSample{
			queryPBXEndpoints: {
				sample(2, "resource", "line1"),
				sample(2, "resource", "line2"),
				sample(2, "resource", "line3"),
				sample(2, "resource", "line4"),
			},
			queryPBXTrunks: {
				sample(1, "username", "sip:168847_cathy@montreal10.voip.ms"),
				sample(1, "username", "sip:168847_recorded@montreal10.voip.ms"),
				sample(1, "username", "sip:168847_sandbox@montreal10.voip.ms"),
				sample(1, "username", "sip:168847_1994@montreal10.voip.ms"),
			},
			queryPBXCalls: {sample(0)},
		},
	}

	pbx, err := collectPBX(context.Background(), src)
	if err != nil {
		t.Fatal(err)
	}
	if len(pbx.Lines) != 4 {
		t.Fatalf("want 4 lines, got %+v", pbx.Lines)
	}
	for _, line := range pbx.Lines {
		if !line.Handset || !line.Trunk {
			t.Errorf("line %+v should be fully registered", line)
		}
	}
	if pbx.OnAir {
		t.Error("no active calls should mean not on air")
	}
}

func TestCollectPBXPartialAndOnAir(t *testing.T) {
	src := &cannedProm{
		vec: map[string][]promSample{
			queryPBXEndpoints: {
				sample(2, "resource", "line1"),
				sample(1, "resource", "line2"), // offline
				sample(2, "resource", "line3"),
				sample(0, "resource", "line4"), // unknown
			},
			queryPBXTrunks: {
				sample(1, "username", "sip:168847_cathy@montreal10.voip.ms"),
				sample(1, "username", "sip:168847_recorded@montreal10.voip.ms"),
				sample(2, "username", "sip:168847_sandbox@montreal10.voip.ms"), // rejected
				sample(0, "username", "sip:168847_1994@montreal10.voip.ms"),    // unregistered
			},
			queryPBXCalls: {sample(1)},
		},
	}

	pbx, err := collectPBX(context.Background(), src)
	if err != nil {
		t.Fatal(err)
	}
	if !pbx.Lines[0].Handset || !pbx.Lines[0].Trunk {
		t.Errorf("line1 should be fully registered, got %+v", pbx.Lines[0])
	}
	if pbx.Lines[1].Handset {
		t.Errorf("line2 handset is offline (state 1), got %+v", pbx.Lines[1])
	}
	if !pbx.Lines[2].Handset || pbx.Lines[2].Trunk {
		t.Errorf("line3 handset up but trunk rejected (state 2), got %+v", pbx.Lines[2])
	}
	if pbx.Lines[3].Handset || pbx.Lines[3].Trunk {
		t.Errorf("line4 handset unknown and trunk unregistered, got %+v", pbx.Lines[3])
	}
	if !pbx.OnAir {
		t.Error("an active call should be on air")
	}
}

func TestCollectPBXAbsent(t *testing.T) {
	// No PBX namespace scraped at all: every query returns an empty vector
	// (a real Prometheus "success" with no series), not an error.
	src := &cannedProm{}

	pbx, err := collectPBX(context.Background(), src)
	if err != nil {
		t.Fatalf("an absent PBX must not be an error: %v", err)
	}
	if len(pbx.Lines) != 4 {
		t.Fatalf("want 4 lines even when absent, got %+v", pbx.Lines)
	}
	for _, line := range pbx.Lines {
		if line.Handset || line.Trunk {
			t.Errorf("an absent PBX should leave every line off, got %+v", line)
		}
	}
	if pbx.OnAir {
		t.Error("an absent PBX should not be on air")
	}
}

func TestCollectPBXFailsWithoutEndpoints(t *testing.T) {
	src := &cannedProm{errs: map[string]error{queryPBXEndpoints: fmt.Errorf("prometheus down")}}
	if _, err := collectPBX(context.Background(), src); err == nil {
		t.Fatal("a failed endpoint query must fail PBX collection")
	}
}
