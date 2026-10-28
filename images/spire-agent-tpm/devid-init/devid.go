package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"time"
)

var errNotAttested = errors.New("the attest service holds no LDevID for this serial")

// The files SPIRE's tpm_devid agent plugin reads, named in tpm_devid.conf.
const (
	certFile = "devid.crt.pem"
	pubFile  = "devid.pub.blob"
	privFile = "devid.priv.blob"
)

// DevID is the attest service's answer to GET /devid/<serial>. The LAK fields
// are for re-attestation, which SPIRE does not do: tpm_devid makes its own
// throwaway AK at every attestation.
type DevID struct {
	CertPEM string `json:"ldevid_cert_pem"`
	PubB64  string `json:"ldevid_pub_blob_b64"`
	PrivB64 string `json:"ldevid_priv_blob_b64"`

	cert []*x509.Certificate
	pub  []byte
	priv []byte
}

func fetch(ctx context.Context, c *http.Client, base, serial string) (*DevID, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/devid/"+url.PathEscape(serial), nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	switch {
	case resp.StatusCode == http.StatusNotFound:
		return nil, errNotAttested
	case resp.StatusCode != http.StatusOK:
		return nil, fmt.Errorf("GET %s: %s", req.URL, resp.Status)
	}
	var d DevID
	if err := json.Unmarshal(body, &d); err != nil {
		return nil, fmt.Errorf("decode the LDevID: %w", err)
	}
	return &d, nil
}

// check refuses an LDevID that SPIRE would refuse, or that would map to
// another node: the node alias selects on the subject CN, and the attest
// service sets the serialNumber attribute to the SMBIOS serial.
func (d *DevID) check(node, serial string, now time.Time) error {
	rest := []byte(d.CertPEM)
	for {
		var block *pem.Block
		block, rest = pem.Decode(rest)
		if block == nil {
			break
		}
		if block.Type != "CERTIFICATE" {
			continue
		}
		c, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			return fmt.Errorf("parse the LDevID chain: %w", err)
		}
		d.cert = append(d.cert, c)
	}
	if len(d.cert) == 0 {
		return errors.New("ldevid_cert_pem holds no certificate")
	}
	leaf := d.cert[0]
	if node != "" && leaf.Subject.CommonName != node {
		return fmt.Errorf("the LDevID names %q, not this node %q", leaf.Subject.CommonName, node)
	}
	if leaf.Subject.SerialNumber != serial {
		return fmt.Errorf("the LDevID names serial %q, not this machine's %q", leaf.Subject.SerialNumber, serial)
	}
	if now.Before(leaf.NotBefore) || now.After(leaf.NotAfter) {
		return fmt.Errorf("the LDevID is valid from %s to %s", leaf.NotBefore, leaf.NotAfter)
	}

	var err error
	if d.pub, err = blob(d.PubB64); err != nil {
		return fmt.Errorf("ldevid_pub_blob_b64: %w", err)
	}
	if d.priv, err = blob(d.PrivB64); err != nil {
		return fmt.Errorf("ldevid_priv_blob_b64: %w", err)
	}
	key, err := parsePublic(d.pub)
	if err != nil {
		return fmt.Errorf("ldevid_pub_blob_b64: %w", err)
	}
	if !samePublicKey(key, leaf.PublicKey) {
		return errors.New("the LDevID certificate is not for the key in ldevid_pub_blob_b64")
	}
	return nil
}

// blob decodes a TPM blob and drops a TPM2B size prefix if it has one. SPIRE
// hands each file to go-tpm, which adds the prefix itself, so a blob written
// by tpm2_create would not load as is.
func blob(b64 string) ([]byte, error) {
	b, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return nil, err
	}
	if len(b) == 0 {
		return nil, errors.New("empty")
	}
	if len(b) >= 2 && int(b[0])<<8|int(b[1]) == len(b)-2 {
		b = b[2:]
	}
	return b, nil
}

func samePublicKey(a, b any) bool {
	switch a := a.(type) {
	case *rsa.PublicKey:
		return a.Equal(b)
	case *ecdsa.PublicKey:
		return a.Equal(b)
	}
	return false
}

func (d *DevID) write(dir string) error {
	var chain bytes.Buffer
	for _, c := range d.cert {
		if err := pem.Encode(&chain, &pem.Block{Type: "CERTIFICATE", Bytes: c.Raw}); err != nil {
			return err
		}
	}
	files := map[string][]byte{certFile: chain.Bytes(), pubFile: d.pub, privFile: d.priv}
	for name, data := range files {
		if err := os.WriteFile(filepath.Join(dir, name), data, 0o600); err != nil {
			return err
		}
	}
	return nil
}
