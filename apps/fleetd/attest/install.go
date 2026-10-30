package attest

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/google/go-tpm/legacy/tpm2"
	"github.com/google/go-tpm/legacy/tpm2/credactivation"

	"github.com/jonpulsifer/infra/apps/fleetd/protocol"
)

const installTimeout = 30 * time.Second

// InstallRequest is what an intake pass hands the installer: the machine, and
// the code its Talos config renders under.
type InstallRequest struct {
	Serial string
	UUID   string
	Node   string
	Class  string
	Code   string
}

// Installer renders a machine's Talos config under an install code and
// starts its install, in the same process. Only nil means the config waits
// for the code; an error says why it does not, and never repeats the code.
type Installer interface {
	Install(ctx context.Context, req InstallRequest) error
}

// InstallerFunc adapts a function to Installer.
type InstallerFunc func(context.Context, InstallRequest) error

func (f InstallerFunc) Install(ctx context.Context, req InstallRequest) error { return f(ctx, req) }

var uuidRE = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// smbiosUUID is the claimed SMBIOS UUID lower-cased, when it reads as one.
// It names the config file and fills Talos's ${uuid}, so nothing else passes.
func smbiosUUID(claim string) (string, bool) {
	u := strings.ToLower(claim)
	return u, uuidRE.MatchString(u)
}

// installCode mints a code for an intake pass, wraps it to the session's TPM,
// and has the installer render the machine's config under it. It returns the
// wrapped code only when the config waits for it; otherwise it audits why and
// returns false. The pass stands either way, and the code is never logged.
func (v *Verifier) installCode(ctx context.Context, rec Record, s *session) (protocol.Challenge, bool) {
	raw := v.random(32)
	wrapped, err := wrapToTPM(s, raw)
	uuid, ok := smbiosUUID(rec.UUID)
	switch {
	case err != nil:
	case !ok:
		err = errors.New("the session's SMBIOS UUID is not 8-4-4-4-12 hex")
	default:
		ctx, cancel := context.WithTimeout(ctx, installTimeout)
		err = v.Installer.Install(ctx, InstallRequest{Serial: rec.Serial, UUID: uuid, Node: rec.Machine, Class: rec.Class, Code: base64.RawURLEncoding.EncodeToString(raw)})
		cancel()
	}
	if err != nil {
		v.withholdCode(rec, err)
		return protocol.Challenge{}, false
	}
	v.Log.Info("install code issued", "machine", rec.Machine, "serial", rec.Serial, "uuid", uuid)
	v.Audit.Emit(AuditEntry{Event: auditInstall, Node: rec.Machine, Serial: rec.Serial, Class: rec.Class, Status: "issued"})
	return wrapped, true
}

// withholdCode logs and audits why an intake pass got no install code.
func (v *Verifier) withholdCode(rec Record, why error) {
	v.Log.Warn("install code withheld", "machine", rec.Machine, "serial", rec.Serial, "err", why)
	v.Audit.Emit(AuditEntry{Event: auditInstall, Node: rec.Machine, Serial: rec.Serial, Class: rec.Class, Status: "withheld", Reason: why.Error()})
}

// wrapToTPM is TPM2_MakeCredential of secret for the session's first EK,
// bound to its AK's name: only that TPM, holding that AK, recovers it.
func wrapToTPM(s *session, secret []byte) (protocol.Challenge, error) {
	if len(s.eks) == 0 {
		return protocol.Challenge{}, errors.New("the session has no EK to wrap the code to")
	}
	pub, err := tpm2.DecodePublic(s.akPublic)
	if err != nil {
		return protocol.Challenge{}, fmt.Errorf("the session's AK: %w", err)
	}
	name, err := pub.Name()
	if err != nil || name.Digest == nil {
		return protocol.Challenge{}, fmt.Errorf("the session's AK has no name: %v", err)
	}
	cred, encSecret, err := credactivation.Generate(name.Digest, s.eks[0].Public, 16, secret)
	if err != nil {
		return protocol.Challenge{}, fmt.Errorf("wrap the code to the TPM: %w", err)
	}
	return protocol.Challenge{EKHash: s.eks[0].Hash, Credential: cred, Secret: encSecret}, nil
}
