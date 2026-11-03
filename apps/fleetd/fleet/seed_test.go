package fleet

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jonpulsifer/infra/apps/fleetd/classes"
)

func testSeedInputs() SeedInputs {
	return SeedInputs{
		PrefixLength: 26,
		Gateway:      "10.3.0.1",
		Resolvers:    []string{"10.9.0.2", "10.9.0.3"},
		DNSZone:      "lolwtf.ca",
		EnrollURL:    "https://enroll.lolwtf.ca",
		DevIDURL:     "http://10.9.0.11:8444",
		Spire:        SeedSpire{Server: "spore.lolwtf.ca:8081", TrustDomain: "lolwtf.ca"},
		SSHKeys:      []string{"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHRlc3Q owner"},
		Profiles: map[string]string{
			classes.PayloadNixOSImage:  "github:jonpulsifer/infra#${name}",
			classes.PayloadAlpineImage: "http://10.9.0.11/alpine/folly/${workload}.apkovl.tar.gz",
		},
	}
}

func testSeeds() *SeedRenderer { return &SeedRenderer{Inputs: testSeedInputs(), Classes: testClasses} }

func TestSeedNamesTheNodeItsProfileAndTheFleet(t *testing.T) {
	out, err := testSeeds().Render(Node{Name: "shale", Serial: "MXL0172Q6L", Class: "nixos", Address: "10.3.0.12", TPM: "2.0"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(string(out), "}\n") {
		t.Fatalf("the seed is not a JSON document ending in a newline: %q", out)
	}
	var s Seed
	if err := json.Unmarshal(out, &s); err != nil {
		t.Fatal(err)
	}
	want := Seed{
		Version: SeedVersion, Name: "shale", Serial: "MXL0172Q6L", Class: "nixos", OS: "nixos", Workload: "general",
		PayloadKind: classes.PayloadNixOSImage, Profile: "github:jonpulsifer/infra#shale",
		Network: SeedNetwork{Address: "10.3.0.12/26", Gateway: "10.3.0.1", Resolvers: []string{"10.9.0.2", "10.9.0.3"}, DNSZone: "lolwtf.ca"},
		Fleet:   SeedFleet{EnrollURL: "https://enroll.lolwtf.ca", DevIDURL: "http://10.9.0.11:8444/devid/MXL0172Q6L", VerdictURL: "http://10.9.0.11:8444/verdict/MXL0172Q6L"},
		Spire:   SeedSpire{Server: "spore.lolwtf.ca:8081", TrustDomain: "lolwtf.ca"},
		SSHKeys: testSeedInputs().SSHKeys,
	}
	got, _ := json.Marshal(s)
	exp, _ := json.Marshal(want)
	if string(got) != string(exp) {
		t.Fatalf("seed\n got %s\nwant %s", got, exp)
	}

	// An Alpine class's profile is the overlay its workload names.
	out, err = testSeeds().Render(Node{Name: "surge", Serial: "S1", Class: "alpine", Address: "10.3.0.13"})
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(out, &s); err != nil || s.Profile != "http://10.9.0.11/alpine/folly/general.apkovl.tar.gz" || s.OS != "alpine" {
		t.Fatalf("alpine seed: %v %+v", err, s)
	}
}

func TestSeedRefusesWhatItCannotName(t *testing.T) {
	good := Node{Name: "shale", Serial: "MXL0172Q6L", Class: "nixos", Address: "10.3.0.12"}
	for name, tc := range map[string]struct {
		node  func(Node) Node
		seeds func(*SeedRenderer)
		want  string
	}{
		"no class":        {node: func(n Node) Node { n.Class = "worker-g9"; return n }, want: "not in the class inputs"},
		"a Talos class":   {node: func(n Node) Node { n.Class = "worker-g5"; return n }, want: "no seed"},
		"no address":      {node: func(n Node) Node { n.Address = ""; return n }, want: "IPv4 address"},
		"an IPv6 address": {node: func(n Node) Node { n.Address = "fd00::12"; return n }, want: "IPv4 address"},
		"no serial":       {node: func(n Node) Node { n.Serial = ""; return n }, want: "serial"},
		"no profile":      {seeds: func(s *SeedRenderer) { delete(s.Inputs.Profiles, classes.PayloadNixOSImage) }, want: "no nixos-image profile"},
	} {
		s, n := testSeeds(), good
		if tc.node != nil {
			n = tc.node(n)
		}
		if tc.seeds != nil {
			tc.seeds(s)
		}
		if _, err := s.Render(n); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestLoadSeedInputsChecksTheFile(t *testing.T) {
	write := func(t *testing.T, in SeedInputs) string {
		t.Helper()
		b, _ := json.Marshal(in)
		p := filepath.Join(t.TempDir(), "seed-inputs.json")
		if err := os.WriteFile(p, b, 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	if got, err := LoadSeedInputs(write(t, testSeedInputs())); err != nil || got.Gateway != "10.3.0.1" || len(got.Profiles) != 2 {
		t.Fatalf("a good file: %v %+v", err, got)
	}
	for name, tc := range map[string]struct {
		change func(*SeedInputs)
		want   string
	}{
		"prefix":          {func(in *SeedInputs) { in.PrefixLength = 0 }, "prefix_length"},
		"gateway":         {func(in *SeedInputs) { in.Gateway = "gw" }, "gateway"},
		"no resolvers":    {func(in *SeedInputs) { in.Resolvers = nil }, "resolvers"},
		"a bad resolver":  {func(in *SeedInputs) { in.Resolvers = []string{"ns"} }, "resolver"},
		"no zone":         {func(in *SeedInputs) { in.DNSZone = "" }, "dns_zone"},
		"a path":          {func(in *SeedInputs) { in.EnrollURL = "https://enroll.lolwtf.ca/attest" }, "enroll_url"},
		"a bare host":     {func(in *SeedInputs) { in.DevIDURL = "10.9.0.11:8444" }, "devid_url"},
		"spire port":      {func(in *SeedInputs) { in.Spire.Server = "spore.lolwtf.ca" }, "spire.server"},
		"trust domain":    {func(in *SeedInputs) { in.Spire.TrustDomain = "" }, "trust_domain"},
		"a two-line key":  {func(in *SeedInputs) { in.SSHKeys = []string{"ssh-ed25519 A\nssh-ed25519 B"} }, "ssh_authorized_keys"},
		"no profiles":     {func(in *SeedInputs) { in.Profiles = nil }, "profiles"},
		"a Talos profile": {func(in *SeedInputs) { in.Profiles[classes.PayloadTalosConfig] = "x" }, "no seed payload kind"},
		"an empty one":    {func(in *SeedInputs) { in.Profiles[classes.PayloadNixOSImage] = " " }, "profile is empty"},
	} {
		in := testSeedInputs()
		tc.change(&in)
		if _, err := LoadSeedInputs(write(t, in)); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, err := LoadSeedInputs(filepath.Join(t.TempDir(), "none.json")); err == nil {
		t.Error("a missing file loaded")
	}
}
