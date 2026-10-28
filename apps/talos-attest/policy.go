package main

import (
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"fmt"
	"os"
	"slices"
	"sort"
	"strings"

	"github.com/google/go-attestation/attest"
	"gopkg.in/yaml.v3"
)

// Policy is what a replayed event log must show. Certificates are named by
// the lowercase hex SHA-256 of their DER. policy.yaml is the instance.
type Policy struct {
	// PCRs the quote must cover in the SHA-256 bank.
	PCRs []int `yaml:"pcrs"`
	// SecureBoot requires the firmware to measure SecureBoot=1 in PCR 7.
	SecureBoot bool `yaml:"secure_boot"`
	// PlatformKeys is the PK, exactly.
	PlatformKeys []string `yaml:"platform_keys"`
	// KeyExchangeKeys may hold every KEK entry, and nothing else may be one.
	KeyExchangeKeys []string `yaml:"key_exchange_keys"`
	DB              struct {
		// Required must all be in db.
		Required []string `yaml:"required"`
		// Allowed may also be in db. Nothing else may, and no image hash.
		Allowed []string `yaml:"allowed"`
	} `yaml:"db"`
	// PreSeparatorAuthorities may verify firmware drivers and option ROMs.
	PreSeparatorAuthorities []string `yaml:"pre_separator_authorities"`
	// Authorities may verify a boot application after the separator, and
	// nothing else may.
	Authorities []string `yaml:"authorities"`
	// RequiredAuthorities must each have verified a boot application: the
	// one that signs HookOS proves the attest ran in HookOS.
	RequiredAuthorities []string `yaml:"required_authorities"`
	// BootApplications, when set, lists the Authenticode SHA-256 of every
	// boot application PCR 4 may record after the separator.
	BootApplications []string `yaml:"boot_applications"`
	// Names labels fingerprints in verdicts.
	Names map[string]string `yaml:"names"`
}

// LoadPolicy reads and checks a policy file.
func LoadPolicy(path string) (*Policy, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var p Policy
	dec := yaml.NewDecoder(strings.NewReader(string(b)))
	dec.KnownFields(true)
	if err := dec.Decode(&p); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if len(p.PCRs) == 0 {
		return nil, fmt.Errorf("%s: pcrs is empty", path)
	}
	for _, i := range p.PCRs {
		if i < 0 || i > 23 {
			return nil, fmt.Errorf("%s: PCR %d", path, i)
		}
	}
	return &p, nil
}

func fingerprint(c x509.Certificate) string {
	sum := sha256.Sum256(c.Raw)
	return hex.EncodeToString(sum[:])
}

func (p *Policy) name(fp string) string {
	if n, ok := p.Names[fp]; ok {
		return n
	}
	return fp
}

// Evaluate returns every way the verified events break the policy. The
// events must come from EventLog.Verify against quoted PCRs.
func (p *Policy) Evaluate(events []attest.Event) []string {
	var v []string
	sb, err := attest.ParseSecurebootState(events)
	if err != nil {
		return []string{fmt.Sprintf("PCR 7 does not parse as a Secure Boot log: %v", err)}
	}
	if p.SecureBoot && !sb.Enabled {
		v = append(v, "Secure Boot is off")
	}
	fps := func(cs []x509.Certificate) []string {
		out := make([]string, 0, len(cs))
		for _, c := range cs {
			out = append(out, fingerprint(c))
		}
		return out
	}
	only := func(what string, got, allowed []string) {
		for _, fp := range got {
			if !slices.Contains(allowed, fp) {
				v = append(v, fmt.Sprintf("%s holds %s, which the policy does not allow", what, p.name(fp)))
			}
		}
	}
	need := func(what string, got, required []string) {
		for _, fp := range required {
			if !slices.Contains(got, fp) {
				v = append(v, fmt.Sprintf("%s lacks %s", what, p.name(fp)))
			}
		}
	}

	pk := fps(sb.PlatformKeys)
	if len(sb.PlatformKeyHashes) > 0 {
		v = append(v, "PK holds a hash")
	}
	only("PK", pk, p.PlatformKeys)
	need("PK", pk, p.PlatformKeys)
	if len(sb.ExchangeKeyHashes) > 0 {
		v = append(v, "KEK holds a hash")
	}
	only("KEK", fps(sb.ExchangeKeys), p.KeyExchangeKeys)
	db := fps(sb.PermittedKeys)
	need("db", db, p.DB.Required)
	only("db", db, append(slices.Clone(p.DB.Required), p.DB.Allowed...))
	if len(sb.PermittedHashes) > 0 {
		v = append(v, fmt.Sprintf("db holds %d image hashes", len(sb.PermittedHashes)))
	}
	only("A pre-separator authority", fps(sb.PreSeparatorAuthority), append(slices.Clone(p.PreSeparatorAuthorities), p.Authorities...))
	post := fps(sb.PostSeparatorAuthority)
	only("A boot authority", post, p.Authorities)
	need("The boot path", post, p.RequiredAuthorities)

	if len(p.BootApplications) > 0 {
		for _, d := range bootApplications(events) {
			if !slices.Contains(p.BootApplications, d) {
				v = append(v, fmt.Sprintf("PCR 4 records boot application %s, which the policy does not list", d))
			}
		}
	}
	sort.Strings(v)
	return slices.Compact(v)
}

// bootApplications returns the Authenticode digests PCR 4 records after its
// separator: what the firmware loaded from the boot option onward.
func bootApplications(events []attest.Event) []string {
	var out []string
	separated := false
	for _, e := range events {
		if e.Index != 4 {
			continue
		}
		switch e.Type {
		case eventSeparator:
			separated = true
		case eventBootServicesApplication:
			if separated {
				out = append(out, hex.EncodeToString(e.Digest))
			}
		}
	}
	return out
}

const (
	eventSeparator               attest.EventType = 0x00000004
	eventBootServicesApplication attest.EventType = 0x80000003
)
