package jcs

import (
	"encoding/binary"
	"encoding/hex"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestPublishedVectors runs the JCS reference test data from
// cyberphone/json-canonicalization, vendored under testdata/jcs. Between them
// they cover the four things that actually go wrong: number formatting, string
// escaping, recursive property sorting, and sorting by UTF-16 code units rather
// than by UTF-8 bytes.
func TestPublishedVectors(t *testing.T) {
	names, err := filepath.Glob("../testdata/jcs/input/*.json")
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 6 {
		t.Fatalf("%d input vectors, want 6", len(names))
	}
	for _, in := range names {
		name := filepath.Base(in)
		t.Run(name, func(t *testing.T) {
			raw, err := os.ReadFile(in)
			if err != nil {
				t.Fatal(err)
			}
			want, err := os.ReadFile(filepath.Join("../testdata/jcs/output", name))
			if err != nil {
				t.Fatal(err)
			}
			got, err := Canonical(raw)
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != string(want) {
				t.Errorf("\n got %s\nwant %s", got, want)
			}
			// Canonicalising a canonical document must be a no-op, or the
			// output is not a fixed point and re-signing changes the bytes.
			again, err := Canonical(got)
			if err != nil {
				t.Fatal(err)
			}
			if string(again) != string(got) {
				t.Errorf("not idempotent:\n%s\n%s", got, again)
			}
		})
	}
}

// TestRFC8785Bytes is the exact octet sequence RFC 8785 section 3.2.4 prints
// for its running example, checked as bytes rather than as a string so a UTF-8
// mistake cannot hide behind a terminal.
func TestRFC8785Bytes(t *testing.T) {
	raw, err := os.ReadFile("../testdata/jcs/input/values.json")
	if err != nil {
		t.Fatal(err)
	}
	got, err := Canonical(raw)
	if err != nil {
		t.Fatal(err)
	}
	want := []byte{
		0x7b, 0x22, 0x6c, 0x69, 0x74, 0x65, 0x72, 0x61, 0x6c, 0x73, 0x22, 0x3a, 0x5b, 0x6e, 0x75, 0x6c,
		0x6c, 0x2c, 0x74, 0x72, 0x75, 0x65, 0x2c, 0x66, 0x61, 0x6c, 0x73, 0x65, 0x5d, 0x2c, 0x22, 0x6e,
		0x75, 0x6d, 0x62, 0x65, 0x72, 0x73, 0x22, 0x3a, 0x5b, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33,
		0x33, 0x33, 0x2e, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x2c, 0x31, 0x65, 0x2b, 0x33, 0x30,
		0x2c, 0x34, 0x2e, 0x35, 0x2c, 0x30, 0x2e, 0x30, 0x30, 0x32, 0x2c, 0x31, 0x65, 0x2d, 0x32, 0x37,
		0x5d, 0x2c, 0x22, 0x73, 0x74, 0x72, 0x69, 0x6e, 0x67, 0x22, 0x3a, 0x22, 0xe2, 0x82, 0xac, 0x24,
		0x5c, 0x75, 0x30, 0x30, 0x30, 0x66, 0x5c, 0x6e, 0x41, 0x27, 0x42, 0x5c, 0x22, 0x5c, 0x5c, 0x5c,
		0x5c, 0x5c, 0x22, 0x2f, 0x22, 0x7d,
	}
	if string(got) != string(want) {
		t.Errorf("\n got % x\nwant % x", got, want)
	}
}

// TestAppendixB is RFC 8785's number serialization table, addressed by the IEEE
// 754 bit pattern so the test does not depend on Go's own parsing of a decimal
// literal.
func TestAppendixB(t *testing.T) {
	for _, tc := range []struct{ ieee, want string }{
		{"0000000000000000", "0"},
		{"8000000000000000", "0"},
		{"0000000000000001", "5e-324"},
		{"8000000000000001", "-5e-324"},
		{"7fefffffffffffff", "1.7976931348623157e+308"},
		{"ffefffffffffffff", "-1.7976931348623157e+308"},
		{"4340000000000000", "9007199254740992"},
		{"c340000000000000", "-9007199254740992"},
		{"4430000000000000", "295147905179352830000"},
		{"44b52d02c7e14af5", "9.999999999999997e+22"},
		{"44b52d02c7e14af6", "1e+23"},
		{"44b52d02c7e14af7", "1.0000000000000001e+23"},
		{"444b1ae4d6e2ef4e", "999999999999999700000"},
		{"444b1ae4d6e2ef4f", "999999999999999900000"},
		{"444b1ae4d6e2ef50", "1e+21"},
		{"3eb0c6f7a0b5ed8c", "9.999999999999997e-7"},
		{"3eb0c6f7a0b5ed8d", "0.000001"},
		{"41b3de4355555553", "333333333.3333332"},
		{"41b3de4355555554", "333333333.33333325"},
		{"41b3de4355555555", "333333333.3333333"},
		{"41b3de4355555556", "333333333.3333334"},
		{"41b3de4355555557", "333333333.33333343"},
		{"becbf647612f3696", "-0.0000033333333333333333"},
		{"43143ff3c1cb0959", "1424953923781206.2"},
	} {
		b, err := hex.DecodeString(tc.ieee)
		if err != nil {
			t.Fatal(err)
		}
		f := math.Float64frombits(binary.BigEndian.Uint64(b))
		got, err := formatNumber(f)
		if err != nil {
			t.Fatalf("%s: %v", tc.ieee, err)
		}
		if got != tc.want {
			t.Errorf("%s: got %s, want %s", tc.ieee, got, tc.want)
		}
	}
	// NaN and Infinity are not permitted in JSON and must terminate the
	// canonicalisation rather than emit something a parser will not read back.
	for _, f := range []float64{math.NaN(), math.Inf(1), math.Inf(-1)} {
		if _, err := formatNumber(f); err == nil {
			t.Errorf("%v was serialised", f)
		}
	}
}

func TestRejection(t *testing.T) {
	for name, in := range map[string]string{
		"duplicate key":        `{"a":1,"a":2}`,
		"duplicate nested key": `{"o":{"a":1,"a":2}}`,
		"trailing data":        `{"a":1} {"b":2}`,
		"trailing garbage":     `{"a":1}x`,
		"truncated":            `{"a":`,
		"not json":             `nope`,
		"empty":                ``,
	} {
		if got, err := Canonical([]byte(in)); err == nil {
			t.Errorf("%s: accepted %q as %s", name, in, got)
		}
	}
}

// TestMarshalTranscriptShape is the shape a transcript actually has — nested
// objects, arrays of objects, small integers, hex strings — canonicalised and
// then canonicalised again to confirm the signed bytes are a fixed point.
func TestMarshalTranscriptShape(t *testing.T) {
	type leaf struct {
		Path   string `json:"path"`
		Type   string `json:"type"`
		Public string `json:"public"`
	}
	doc := map[string]any{
		"spec_sha256": strings.Repeat("ab", 32),
		"shares": []map[string]any{
			{"set": "master", "threshold": 3, "count": 5},
			{"set": "fml/infra/v1", "threshold": 2, "count": 3},
		},
		"leaves": []leaf{
			{Path: "fml/infra/v1/pki/root/v1", Type: "ed25519", Public: "58fee097"},
			{Path: "fml/infra/v1/age/operator/v1", Type: "x25519-age", Public: "age1uzf08"},
		},
		"reserved": []string{"fml/kms", "fml/ssh"},
	}
	got, err := Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"leaves":[{"path":"fml/infra/v1/pki/root/v1","public":"58fee097","type":"ed25519"},` +
		`{"path":"fml/infra/v1/age/operator/v1","public":"age1uzf08","type":"x25519-age"}],` +
		`"reserved":["fml/kms","fml/ssh"],` +
		`"shares":[{"count":5,"set":"master","threshold":3},{"count":3,"set":"fml/infra/v1","threshold":2}],` +
		`"spec_sha256":"` + strings.Repeat("ab", 32) + `"}`
	if string(got) != want {
		t.Errorf("\n got %s\nwant %s", got, want)
	}
	again, err := Canonical(got)
	if err != nil {
		t.Fatal(err)
	}
	if string(again) != string(got) {
		t.Error("canonical output is not a fixed point")
	}
}
