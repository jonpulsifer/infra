package fleet

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"net/url"
	"os"
	"strings"

	"github.com/jonpulsifer/infra/apps/fleetd/classes"
)

// SeedInputs is what every seed shares, from the file nix/services/fleetd.nix
// writes: the network a node's address sits in, the fleet's endpoints, the
// SPIRE server, the owner's SSH keys, and the profile each payload kind names.
type SeedInputs struct {
	PrefixLength int      `json:"prefix_length"`
	Gateway      string   `json:"gateway"`
	Resolvers    []string `json:"resolvers"`
	DNSZone      string   `json:"dns_zone"`
	// EnrollURL is the boot listener's origin, where the device flow and the
	// seed itself are; DevIDURL is the DevID listener's, where a node fetches
	// its LDevID package and verdict.
	EnrollURL string    `json:"enroll_url"`
	DevIDURL  string    `json:"devid_url"`
	Spire     SeedSpire `json:"spire"`
	SSHKeys   []string  `json:"ssh_authorized_keys"`
	// Profiles maps a payload kind to the profile its seed names, with
	// ${name}, ${class} and ${workload} filled from the node: a flake
	// attribute for nixos-image, an apkovl URL for alpine-image.
	Profiles map[string]string `json:"profiles"`
}

// SeedSpire is the SPIRE server a node's agent attests to.
type SeedSpire struct {
	Server      string `json:"server"`
	TrustDomain string `json:"trust_domain"`
}

// Seed is the document a non-Talos node's first boot reads once: who it is,
// what it switches into, its address, and where the fleet is.
type Seed struct {
	Version     int         `json:"version"`
	Name        string      `json:"name"`
	Serial      string      `json:"serial"`
	Class       string      `json:"class"`
	OS          string      `json:"os"`
	Workload    string      `json:"workload"`
	PayloadKind string      `json:"payload_kind"`
	Profile     string      `json:"profile"`
	Network     SeedNetwork `json:"network"`
	Fleet       SeedFleet   `json:"fleet"`
	Spire       SeedSpire   `json:"spire"`
	SSHKeys     []string    `json:"ssh_authorized_keys"`
}

// SeedNetwork is the node's static address, as the Talos node document gives
// a Talos node its own.
type SeedNetwork struct {
	Address   string   `json:"address"`
	Gateway   string   `json:"gateway"`
	Resolvers []string `json:"resolvers"`
	DNSZone   string   `json:"dns_zone"`
}

// SeedFleet is where the node reaches fleetd after its first boot.
type SeedFleet struct {
	EnrollURL  string `json:"enroll_url"`
	DevIDURL   string `json:"devid_url"`
	VerdictURL string `json:"verdict_url"`
}

// SeedVersion is the seed's shape; a reader refuses a version it does not know.
const SeedVersion = 1

// SeedKind says whether a payload kind is served as a seed.
func SeedKind(kind string) bool {
	return kind == classes.PayloadNixOSImage || kind == classes.PayloadAlpineImage
}

// LoadSeedInputs reads and checks the seed inputs.
func LoadSeedInputs(path string) (SeedInputs, error) {
	var in SeedInputs
	raw, err := os.ReadFile(path)
	if err != nil {
		return in, err
	}
	if err := json.Unmarshal(raw, &in); err != nil {
		return in, fmt.Errorf("%s: %w", path, err)
	}
	if err := in.validate(); err != nil {
		return in, fmt.Errorf("%s: %w", path, err)
	}
	return in, nil
}

func (in SeedInputs) validate() error {
	if in.PrefixLength < 1 || in.PrefixLength > 30 {
		return fmt.Errorf("prefix_length %d is not 1 to 30", in.PrefixLength)
	}
	if !ipv4(in.Gateway) {
		return fmt.Errorf("gateway %q is not an IPv4 address", in.Gateway)
	}
	if len(in.Resolvers) == 0 {
		return errors.New("resolvers is empty")
	}
	for _, r := range in.Resolvers {
		if !ipv4(r) {
			return fmt.Errorf("resolver %q is not an IPv4 address", r)
		}
	}
	if in.DNSZone == "" || in.Spire.TrustDomain == "" {
		return errors.New("dns_zone and spire.trust_domain are required")
	}
	for name, u := range map[string]string{"enroll_url": in.EnrollURL, "devid_url": in.DevIDURL} {
		p, err := url.Parse(u)
		if err != nil || (p.Scheme != "https" && p.Scheme != "http") || p.Host == "" || p.Path != "" || p.RawQuery != "" {
			return fmt.Errorf("%s %q is not an http(s) origin", name, u)
		}
	}
	if host, port, ok := strings.Cut(in.Spire.Server, ":"); !ok || host == "" || port == "" {
		return fmt.Errorf("spire.server %q is not host:port", in.Spire.Server)
	}
	for _, k := range in.SSHKeys {
		if strings.TrimSpace(k) == "" || strings.ContainsAny(k, "\n\r") {
			return errors.New("ssh_authorized_keys holds an empty or multi-line key")
		}
	}
	if len(in.Profiles) == 0 {
		return errors.New("profiles is empty")
	}
	for kind, p := range in.Profiles {
		if !SeedKind(kind) {
			return fmt.Errorf("profiles names %q, which is no seed payload kind", kind)
		}
		if strings.TrimSpace(p) == "" {
			return fmt.Errorf("the %s profile is empty", kind)
		}
	}
	return nil
}

func ipv4(s string) bool {
	a, err := netip.ParseAddr(s)
	return err == nil && a.Is4()
}

// SeedRenderer renders a node's seed from the inputs and its class.
type SeedRenderer struct {
	Inputs  SeedInputs
	Classes classes.Table
}

// Render is the node's seed as JSON. It refuses a node whose class the table
// lacks or whose payload kind has no profile, and one without an IPv4
// address, a name or a serial.
func (s *SeedRenderer) Render(n Node) ([]byte, error) {
	c, ok := s.Classes[n.Class]
	if !ok {
		return nil, fmt.Errorf("%w: %q", ErrNoClass, n.Class)
	}
	if !SeedKind(c.PayloadKind) {
		return nil, fmt.Errorf("class %q renders %s, which is no seed", n.Class, c.PayloadKind)
	}
	profile, ok := s.Inputs.Profiles[c.PayloadKind]
	if !ok {
		return nil, fmt.Errorf("the seed inputs name no %s profile", c.PayloadKind)
	}
	if n.Name == "" || n.Serial == "" {
		return nil, fmt.Errorf("node %q has no name or serial", n.Name)
	}
	if !ipv4(n.Address) {
		return nil, fmt.Errorf("node %q has no IPv4 address for its seed: %q", n.Name, n.Address)
	}
	fill := strings.NewReplacer("${name}", n.Name, "${class}", n.Class, "${workload}", c.Workload)
	seed := Seed{
		Version:     SeedVersion,
		Name:        n.Name,
		Serial:      n.Serial,
		Class:       n.Class,
		OS:          c.OS,
		Workload:    c.Workload,
		PayloadKind: c.PayloadKind,
		Profile:     fill.Replace(profile),
		Network: SeedNetwork{
			Address:   fmt.Sprintf("%s/%d", n.Address, s.Inputs.PrefixLength),
			Gateway:   s.Inputs.Gateway,
			Resolvers: append([]string{}, s.Inputs.Resolvers...),
			DNSZone:   s.Inputs.DNSZone,
		},
		Fleet: SeedFleet{
			EnrollURL:  s.Inputs.EnrollURL,
			DevIDURL:   s.Inputs.DevIDURL + "/devid/" + url.PathEscape(n.Serial),
			VerdictURL: s.Inputs.DevIDURL + "/verdict/" + url.PathEscape(n.Serial),
		},
		Spire:   s.Inputs.Spire,
		SSHKeys: append([]string{}, s.Inputs.SSHKeys...),
	}
	out, err := json.MarshalIndent(seed, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(out, '\n'), nil
}
