package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/google/go-tpm/legacy/tpm2"
	"github.com/google/go-tpm/legacy/tpm2/credactivation"

	"github.com/jonpulsifer/infra/apps/talos-attest/protocol"
)

// FleetSignatureHeader carries HMAC-SHA512 hex over the render request's
// body, keyed with the fleet secret.
const FleetSignatureHeader = "X-Fleet-Signature"

const renderTimeout = 30 * time.Second

// FleetRender asks fleet-controller to render a machine's Talos config under
// an install code, after an intake pass. Only a 201 means the file exists.
type FleetRender struct {
	URL    string
	Secret []byte
	Client *http.Client
}

// NewFleetRender's client never follows a redirect, which would send the
// body and its signature somewhere else.
func NewFleetRender(url string, secret []byte) *FleetRender {
	return &FleetRender{URL: url, Secret: secret, Client: &http.Client{
		Timeout:       renderTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}
}

// RenderRequest is the body fleet-controller's /render takes.
type RenderRequest struct {
	Serial string `json:"serial"`
	UUID   string `json:"uuid"`
	Node   string `json:"node"`
	Class  string `json:"class"`
	Code   string `json:"code"`
}

// Render posts the signed request and returns nil only on 201. Any other
// answer is an error that names its status alone.
func (f *FleetRender) Render(ctx context.Context, req RenderRequest) error {
	body, err := json.Marshal(req)
	if err != nil {
		return err
	}
	mac := hmac.New(sha512.New, f.Secret)
	mac.Write(body)
	r, err := http.NewRequestWithContext(ctx, http.MethodPost, f.URL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set(FleetSignatureHeader, hex.EncodeToString(mac.Sum(nil)))
	resp, err := f.Client.Do(r)
	if err != nil {
		return fmt.Errorf("fleet-controller render: %w", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		return fmt.Errorf("fleet-controller render answered %d", resp.StatusCode)
	}
	return nil
}

var uuidRE = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// smbiosUUID is the claimed SMBIOS UUID lower-cased, when it reads as one.
// It names the config file and fills Talos's ${uuid}, so nothing else passes.
func smbiosUUID(claim string) (string, bool) {
	u := strings.ToLower(claim)
	return u, uuidRE.MatchString(u)
}

// installCode mints a code for an intake pass, wraps it to the session's TPM,
// and has fleet-controller render the machine's config under it. It returns
// the wrapped code only on the controller's 201; otherwise it audits why and
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
		ctx, cancel := context.WithTimeout(ctx, renderTimeout)
		err = v.Fleet.Render(ctx, RenderRequest{Serial: rec.Serial, UUID: uuid, Node: rec.Machine, Class: rec.Class, Code: base64.RawURLEncoding.EncodeToString(raw)})
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
