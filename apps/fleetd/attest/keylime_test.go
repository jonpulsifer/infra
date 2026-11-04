package attest

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// The cases Keylime's fleetd-profile policy asserts too
// (apps/keylime-policy/testdata/cases.json): each replaces keys of the talos
// profile as the running node sees it and names the verdict. The same file
// drives test_lolwtf_mb_policy.py, so a wording change here that misses the
// Python side fails one of the two.
func TestKeylimePolicyAgreesWithFleetd(t *testing.T) {
	path := inRepo(t, "apps/keylime-policy/testdata/cases.json")
	var file struct {
		Cases []struct {
			Name     string                     `json:"name"`
			Override map[string]json.RawMessage `json:"override"`
			Expect   []string                   `json:"expect"`
		} `json:"cases"`
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &file); err != nil {
		t.Fatal(err)
	}
	events := riptideEvents(t)
	for _, c := range file.Cases {
		t.Run(c.Name, func(t *testing.T) {
			p := loadPolicy(t)
			for key, raw := range c.Override {
				var dst any
				switch key {
				case "required_authorities":
					dst = &p.RenewRequiredAuthorities
				case "db":
					dst = &p.DB
				case "platform_keys":
					dst = &p.PlatformKeys
				case "key_exchange_keys":
					dst = &p.KeyExchangeKeys
				case "authorities":
					dst = &p.Authorities
				case "pre_separator_authorities":
					dst = &p.PreSeparatorAuthorities
				case "boot_applications":
					dst = &p.BootApplications
				case "secure_boot":
					dst = &p.SecureBoot
				default:
					t.Fatalf("case overrides %q, which this test does not map", key)
				}
				if err := json.Unmarshal(raw, dst); err != nil {
					t.Fatalf("%s: %v", key, err)
				}
			}
			got := p.EvaluateRenewal(events)
			if got == nil {
				got = []string{}
			}
			if !reflect.DeepEqual(got, c.Expect) {
				t.Errorf("fleetd says %q, the shared cases expect %q", got, c.Expect)
			}
		})
	}
}

// The committed reference states are a fresh render of the profiles.
func TestKeylimeRefstatesAreRendered(t *testing.T) {
	dir := inRepo(t, "clusters/folly/apps/keylime/policies")
	profiles, err := LoadPolicies("policy")
	if err != nil {
		t.Fatal(err)
	}
	for name, p := range profiles {
		want, err := json.MarshalIndent(KeylimeRefstate(p, true), "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		want = append(want, '\n')
		have, err := os.ReadFile(filepath.Join(dir, name+".json"))
		if err != nil {
			t.Fatalf("%s: %v; run `mise run keylime:render-policies`", name, err)
		}
		if !bytes.Equal(have, want) {
			t.Errorf("%s.json is stale; run `mise run keylime:render-policies`", name)
		}
	}
}

func TestKeylimeRefstateHasEveryList(t *testing.T) {
	var p Policy
	p.PCRs = []int{7}
	r := KeylimeRefstate(&p, false)
	for _, key := range []string{"platform_keys", "key_exchange_keys", "pre_separator_authorities", "authorities", "required_authorities", "boot_applications"} {
		if v, ok := r[key].([]string); !ok || v == nil {
			t.Errorf("%s is %#v, not an empty list", key, r[key])
		}
	}
	if r["names"] == nil || r["db"].(map[string]any)["required"] == nil {
		t.Error("names or db.required is null")
	}
}
