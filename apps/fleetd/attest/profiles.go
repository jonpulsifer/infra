package attest

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"path/filepath"
	"strings"
	"unicode/utf16"

	"github.com/google/go-attestation/attest"

	"github.com/jonpulsifer/infra/apps/fleetd/classes"
)

// defaultProfile judges a machine whose class is empty: a first-sight device
// that attests from HookOS before anyone has declared it.
const defaultProfile = "talos"

// LoadPolicies reads every *.yaml file of a directory as a profile, named by
// its file.
func LoadPolicies(dir string) (map[string]*Policy, error) {
	files, err := filepath.Glob(filepath.Join(dir, "*.yaml"))
	if err != nil {
		return nil, err
	}
	profiles := map[string]*Policy{}
	for _, f := range files {
		p, err := LoadPolicy(f)
		if err != nil {
			return nil, err
		}
		profiles[strings.TrimSuffix(filepath.Base(f), ".yaml")] = p
	}
	if len(profiles) == 0 {
		return nil, fmt.Errorf("%s holds no policy profile", dir)
	}
	return profiles, nil
}

// CheckClasses refuses a class table the profiles cannot serve: a class
// whose profile is missing or disagrees about Secure Boot.
func CheckClasses(table classes.Table, profiles map[string]*Policy) error {
	if _, ok := profiles[defaultProfile]; !ok {
		return fmt.Errorf("no %q policy profile", defaultProfile)
	}
	for name, c := range table {
		p, ok := profiles[c.PolicyProfile]
		switch {
		case !ok:
			return fmt.Errorf("class %s names policy profile %q, which does not exist", name, c.PolicyProfile)
		case p.SecureBoot != c.SecureBoot:
			return fmt.Errorf("class %s expects secure_boot %t and its profile %q requires %t", name, c.SecureBoot, c.PolicyProfile, p.SecureBoot)
		}
	}
	return nil
}

// policyFor picks the profile that judges a machine of the class. A class
// the table lacks, or a renewal from a class that does not reattest, is an
// internal failure: it records and quarantines nothing.
func (v *Verifier) policyFor(class string, renewal bool) (*Policy, error) {
	name := defaultProfile
	if class != "" {
		c, ok := v.Classes[class]
		if !ok {
			return nil, fail(reasonInternal, "the class table has no class %q", class)
		}
		if renewal && !c.Reattest {
			return nil, fail(reasonInternal, "class %q does not renew or check", class)
		}
		name = c.PolicyProfile
	}
	p, ok := v.Policies[name]
	if !ok {
		return nil, fail(reasonInternal, "there is no policy profile %q", name)
	}
	return p, nil
}

// bootFacts are what the firmware and shim measured about revocation: the
// SHA-256 of the dbx variable and of shim's SbatLevel variable. Either is
// empty when the log holds none.
type bootFacts struct {
	DBX  string `json:"dbx,omitempty"`
	SBAT string `json:"sbat,omitempty"`
}

// noteBoot records the revocation facts the log holds, and keeps the older
// one for a fact it lacks: only shim measures the SBAT level.
func (r *Record) noteBoot(events []attest.Event) {
	f := bootFactsOf(events)
	if f.DBX != "" {
		r.Boot.DBX = f.DBX
	}
	if f.SBAT != "" {
		r.Boot.SBAT = f.SBAT
	}
}

const (
	eventVariableDriverConfig attest.EventType = 0x80000001
	eventVariableAuthority    attest.EventType = 0x800000e0
)

func bootFactsOf(events []attest.Event) bootFacts {
	var f bootFacts
	for _, e := range events {
		if e.Index != 7 {
			continue
		}
		switch e.Type {
		case eventVariableDriverConfig:
			if name, data, ok := variableEvent(e.Data); ok && name == "dbx" {
				f.DBX = sha256Hex(data)
			}
		case eventVariableAuthority:
			if name, data, ok := variableEvent(e.Data); ok && name == "SbatLevel" {
				f.SBAT = sha256Hex(data)
			}
		}
	}
	return f
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// variableEvent splits a UEFI_VARIABLE_DATA event into the variable's name
// and value.
func variableEvent(b []byte) (name string, data []byte, ok bool) {
	if len(b) < 32 {
		return "", nil, false
	}
	nameLen, dataLen := binary.LittleEndian.Uint64(b[16:]), binary.LittleEndian.Uint64(b[24:])
	if nameLen > 256 || dataLen > uint64(len(b)) || 32+2*nameLen+dataLen > uint64(len(b)) {
		return "", nil, false
	}
	u := make([]uint16, nameLen)
	for i := range u {
		u[i] = binary.LittleEndian.Uint16(b[32+2*i:])
	}
	start := 32 + 2*nameLen
	return string(utf16.Decode(u)), b[start : start+dataLen], true
}
