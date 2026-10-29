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
	"io"
	"net/http"
	"strings"
	"time"
)

// FleetSignatureHeader carries HMAC-SHA512 hex over the render request's
// body, keyed with the fleet secret.
const FleetSignatureHeader = "X-Fleet-Signature"

// FleetRender asks fleet-controller to render a machine's Talos config under
// an install code, after an intake pass. Only a 201 means the file exists.
type FleetRender struct {
	URL    string
	Secret []byte
	Client *http.Client
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
// answer is an error that says why, without the code.
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
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusCreated {
		return nil
	}
	msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	return fmt.Errorf("fleet-controller render answered %s: %s", resp.Status, plain(strings.TrimSpace(string(msg))))
}

const renderTimeout = 30 * time.Second

// installCode mints a code for an intake pass and has fleet-controller render
// the machine's config under it. It returns the code only on the
// controller's 201; otherwise it returns "" and audits why. The pass stands
// either way, and the code is never logged.
func (v *Verifier) installCode(ctx context.Context, rec Record) string {
	entry := AuditEntry{Event: auditInstall, Node: rec.Machine, Serial: rec.Serial, Class: rec.Class}
	uuid := strings.ToLower(rec.UUID)
	code := base64.RawURLEncoding.EncodeToString(v.random(32))
	var err error
	if uuid == "" {
		err = errors.New("the session carries no SMBIOS UUID, which the config's URL names")
	} else {
		ctx, cancel := context.WithTimeout(ctx, renderTimeout)
		err = v.Fleet.Render(ctx, RenderRequest{Serial: rec.Serial, UUID: uuid, Node: rec.Machine, Class: rec.Class, Code: code})
		cancel()
	}
	if err != nil {
		entry.Status, entry.Reason = "withheld", err.Error()
		v.Log.Warn("install code withheld", "machine", rec.Machine, "serial", rec.Serial, "err", err)
		v.Audit.Emit(entry)
		return ""
	}
	entry.Status = "issued"
	v.Log.Info("install code issued", "machine", rec.Machine, "serial", rec.Serial, "uuid", uuid)
	v.Audit.Emit(entry)
	return code
}
