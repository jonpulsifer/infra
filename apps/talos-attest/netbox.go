package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// NetBox mirrors records onto the device with the same serial: the custom
// fields of the NetBox plan, its status and a journal entry per verdict.
// It never creates a device; a serial NetBox does not know is an error.
type NetBox struct {
	URL    string
	Token  string
	Client *http.Client
	// PassStatus is the status of an attested, confirmed machine.
	PassStatus string
}

func (n *NetBox) do(ctx context.Context, method, path string, body, out any) error {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimSuffix(n.URL, "/")+path, rd)
	if err != nil {
		return err
	}
	// NetBox 4.5's v2 tokens start nbt_ and go as Bearer; older tokens as Token.
	scheme := "Token"
	if strings.HasPrefix(n.Token, "nbt_") {
		scheme = "Bearer"
	}
	req.Header.Set("Authorization", scheme+" "+n.Token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := n.Client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("%s %s: %s: %s", method, path, resp.Status, strings.TrimSpace(string(msg)))
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}

type netboxDevice struct {
	ID           int `json:"id"`
	CustomFields struct {
		EKHash string `json:"ek_hash"`
	} `json:"custom_fields"`
}

func (n *NetBox) device(ctx context.Context, serial string) (netboxDevice, error) {
	var page struct {
		Count   int            `json:"count"`
		Results []netboxDevice `json:"results"`
	}
	if err := n.do(ctx, http.MethodGet, "/api/dcim/devices/?limit=2&serial="+url.QueryEscape(serial), nil, &page); err != nil {
		return netboxDevice{}, err
	}
	if page.Count != 1 || len(page.Results) != 1 {
		return netboxDevice{}, fmt.Errorf("NetBox has %d devices with serial %s", page.Count, serial)
	}
	return page.Results[0], nil
}

func (n *NetBox) deviceID(ctx context.Context, serial string) (int, error) {
	d, err := n.device(ctx, serial)
	return d.ID, err
}

// EKHash implements PinSource: the device's ek_hash custom field, the RSA
// EK's hash, which a pass writes and the owner may set by hand.
func (n *NetBox) EKHash(ctx context.Context, serial string) (string, error) {
	d, err := n.device(ctx, serial)
	return strings.ToLower(d.CustomFields.EKHash), err
}

// Record implements Recorder.
func (n *NetBox) Record(ctx context.Context, r Record) error {
	id, err := n.deviceID(ctx, r.Serial)
	if err != nil {
		return err
	}
	fields := map[string]any{}
	if h := r.EKHashes["rsa"]; h != "" {
		fields["ek_hash"] = h
	} else if h := r.EKHashes["ecc"]; h != "" {
		fields["ek_hash"] = h
	}
	if len(r.EKIssuers) > 0 {
		fields["ek_issuer"] = strings.Join(r.EKIssuers, ", ")
	}
	patch := map[string]any{}
	var kind, comment string
	switch r.Status {
	case StatusAttested:
		fields["ldevid_serial"] = r.LDevIDSerial
		fields["ldevid_not_after"] = r.LDevIDNotAfter.UTC().Format(time.DateOnly)
		fields["lak_serial"] = r.LAKSerial
		fields["last_attested"] = r.AttestedAt.UTC().Format(time.RFC3339)
		if r.Confirmed {
			patch["status"] = n.PassStatus
			kind, comment = "success", fmt.Sprintf("talos-attest: attested; LDevID %s, LAK %s", r.LDevIDSerial, r.LAKSerial)
		}
	case StatusQuarantined:
		patch["status"] = "failed"
		kind, comment = "danger", fmt.Sprintf("talos-attest: quarantined (%s): %s", r.Reason, strings.Join(r.Detail, "; "))
	case StatusPending:
		kind, comment = "warning", fmt.Sprintf("talos-attest: first intake waits for the owner's approval: %s", strings.Join(r.Detail, "; "))
	}
	patch["custom_fields"] = fields
	if err := n.do(ctx, http.MethodPatch, fmt.Sprintf("/api/dcim/devices/%d/", id), patch, nil); err != nil {
		return err
	}
	if comment == "" {
		return nil
	}
	return n.do(ctx, http.MethodPost, "/api/extras/journal-entries/", map[string]any{
		"assigned_object_type": "dcim.device",
		"assigned_object_id":   id,
		"kind":                 kind,
		"comments":             comment,
	}, nil)
}
