package fleet

import (
	"archive/tar"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"net/url"
	"os"
	"strings"
	"time"

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

// SeedKind says whether a payload kind is served as a seed at /seed: the
// JSON seed of a NixOS or Alpine image, or the cloud-init tar of a
// cloud-init image.
func SeedKind(kind string) bool {
	return kind == classes.PayloadNixOSImage || kind == classes.PayloadAlpineImage || kind == classes.PayloadCloudInit
}

// profileKind says whether a payload kind's seed names a profile from the
// seed inputs; a cloud-init seed names none.
func profileKind(kind string) bool {
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
		if !profileKind(kind) {
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

// Render is the node's seed: the JSON a NixOS or Alpine image's first boot
// reads, or the cloud-init tar a cloud-init image's install unpacks
// (CloudInitTar). It refuses a node whose class the table lacks or whose
// payload kind has no profile, and one without an IPv4 address, a name or a
// serial.
func (s *SeedRenderer) Render(n Node) ([]byte, error) {
	seed, err := s.seed(n)
	if err != nil {
		return nil, err
	}
	out, err := json.MarshalIndent(seed, "", "  ")
	if err != nil {
		return nil, err
	}
	out = append(out, '\n')
	if seed.PayloadKind == classes.PayloadCloudInit {
		return CloudInitTar(seed, out)
	}
	return out, nil
}

// seed is the node's Seed, checked.
func (s *SeedRenderer) seed(n Node) (Seed, error) {
	c, ok := s.Classes[n.Class]
	if !ok {
		return Seed{}, fmt.Errorf("%w: %q", ErrNoClass, n.Class)
	}
	if !SeedKind(c.PayloadKind) {
		return Seed{}, fmt.Errorf("class %q renders %s, which is no seed", n.Class, c.PayloadKind)
	}
	profile, ok := s.Inputs.Profiles[c.PayloadKind]
	if !ok && profileKind(c.PayloadKind) {
		return Seed{}, fmt.Errorf("the seed inputs name no %s profile", c.PayloadKind)
	}
	if n.Name == "" || n.Serial == "" {
		return Seed{}, fmt.Errorf("node %q has no name or serial", n.Name)
	}
	if !ipv4(n.Address) {
		return Seed{}, fmt.Errorf("node %q has no IPv4 address for its seed: %q", n.Name, n.Address)
	}
	fill := strings.NewReplacer("${name}", n.Name, "${class}", n.Class, "${workload}", c.Workload)
	return Seed{
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
	}, nil
}

// CloudInitUser is the user a cloud-init seed makes, with the owner's SSH
// keys and passwordless sudo.
const CloudInitUser = "jawn"

// CloudInitSeedPath is where a cloud-init seed's user-data writes the JSON
// seed on the node, as a NixOS image's first boot stores its own.
const CloudInitSeedPath = "/var/lib/fleet/seed.json"

// CloudInitTar is a cloud-init image's seed: a tar of the NoCloud data
// source's meta-data, user-data and network-config, which the install
// unpacks into /var/lib/cloud/seed/nocloud/ on the written root. user-data
// names the host, makes CloudInitUser with the seed's SSH keys, and writes
// the JSON seed at CloudInitSeedPath; network-config gives the node its
// static address. The members have fixed headers, so one seed renders to
// the same bytes each time.
func CloudInitTar(seed Seed, seedJSON []byte) ([]byte, error) {
	fqdn := seed.Name + "." + seed.Network.DNSZone
	var user strings.Builder
	user.WriteString("#cloud-config\n")
	fmt.Fprintf(&user, "hostname: %s\n", yamlString(seed.Name))
	fmt.Fprintf(&user, "fqdn: %s\n", yamlString(fqdn))
	user.WriteString("preserve_hostname: false\n")
	user.WriteString("users:\n")
	fmt.Fprintf(&user, "  - name: %s\n", CloudInitUser)
	user.WriteString("    sudo: \"ALL=(ALL) NOPASSWD:ALL\"\n")
	user.WriteString("    shell: /bin/bash\n")
	user.WriteString("    lock_passwd: true\n")
	user.WriteString("    ssh_authorized_keys:\n")
	for _, k := range seed.SSHKeys {
		fmt.Fprintf(&user, "      - %s\n", yamlString(k))
	}
	if len(seed.SSHKeys) == 0 {
		user.WriteString("      []\n")
	}
	user.WriteString("ssh_pwauth: false\n")
	user.WriteString("package_update: false\n")
	user.WriteString("write_files:\n")
	fmt.Fprintf(&user, "  - path: %s\n", CloudInitSeedPath)
	user.WriteString("    owner: root:root\n")
	user.WriteString("    permissions: \"0600\"\n")
	user.WriteString("    content: |\n")
	for _, line := range strings.Split(strings.TrimRight(string(seedJSON), "\n"), "\n") {
		user.WriteString("      " + line + "\n")
	}

	var meta strings.Builder
	fmt.Fprintf(&meta, "instance-id: %s\n", yamlString(seed.Serial))
	fmt.Fprintf(&meta, "local-hostname: %s\n", yamlString(seed.Name))

	var network strings.Builder
	network.WriteString("version: 2\n")
	network.WriteString("ethernets:\n")
	network.WriteString("  fleet:\n")
	network.WriteString("    match:\n")
	network.WriteString("      name: \"en*\"\n")
	network.WriteString("    dhcp4: false\n")
	network.WriteString("    addresses:\n")
	fmt.Fprintf(&network, "      - %s\n", yamlString(seed.Network.Address))
	network.WriteString("    routes:\n")
	network.WriteString("      - to: default\n")
	fmt.Fprintf(&network, "        via: %s\n", yamlString(seed.Network.Gateway))
	network.WriteString("    nameservers:\n")
	network.WriteString("      addresses:\n")
	for _, r := range seed.Network.Resolvers {
		fmt.Fprintf(&network, "        - %s\n", yamlString(r))
	}
	network.WriteString("      search:\n")
	fmt.Fprintf(&network, "        - %s\n", yamlString(seed.Network.DNSZone))

	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for _, m := range []struct{ name, body string }{
		{"meta-data", meta.String()},
		{"user-data", user.String()},
		{"network-config", network.String()},
	} {
		hdr := &tar.Header{
			Typeflag: tar.TypeReg,
			Name:     m.name,
			Mode:     0o644,
			Size:     int64(len(m.body)),
			ModTime:  time.Unix(0, 0).UTC(),
			Format:   tar.FormatUSTAR,
		}
		if err := tw.WriteHeader(hdr); err != nil {
			return nil, fmt.Errorf("cloud-init %s: %w", m.name, err)
		}
		if _, err := tw.Write([]byte(m.body)); err != nil {
			return nil, fmt.Errorf("cloud-init %s: %w", m.name, err)
		}
	}
	if err := tw.Close(); err != nil {
		return nil, fmt.Errorf("cloud-init tar: %w", err)
	}
	return buf.Bytes(), nil
}

// yamlString is s as a YAML double-quoted scalar, which a JSON string is.
func yamlString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
