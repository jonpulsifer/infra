package client

import (
	"bytes"
	"context"
	"crypto"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/go-tpm/legacy/tpm2"
	"github.com/google/go-tpm/tpmutil"

	"github.com/jonpulsifer/infra/apps/talos-attest/protocol"
)

// RenewConfig is one renewal's inputs.
type RenewConfig struct {
	// BaseURL is the attest service's DevID listener, which serves the
	// LDevID lookup and the renewal routes.
	BaseURL string
	HTTP    *http.Client
	Serial  string
	// EventLog is the running boot's TCG event log.
	EventLog []byte
	// RenewBefore is how long before the LDevID's expiry a renewal is due.
	RenewBefore time.Duration
	// PCRs to quote in the SHA-256 bank.
	PCRs []int
	Now  func() time.Time
	Logf func(format string, args ...any)
}

// RenewResult is what a renewal leaves.
type RenewResult struct {
	// Renewed is false when no renewal was due.
	Renewed bool
	// NotAfter is the expiry of the LDevID now in NV.
	NotAfter time.Time
}

// ErrNoLDevID means the TPM holds no LDevID certificate in NV, so the node
// has nothing to renew until an intake stores one.
var ErrNoLDevID = errors.New("no LDevID certificate in NV")

// Renew asks the service to certify the node's LDevID key again when the
// LDevID in NV expires within cfg.RenewBefore. It signs the boot evidence with
// the LAK, whose blobs, like the LDevID's, it reads from the service's
// LDevID lookup and loads under the SRK, and stores the new certificates in NV.
func Renew(ctx context.Context, rw io.ReadWriter, cfg RenewConfig) (*RenewResult, error) {
	logf := cfg.Logf
	if logf == nil {
		logf = func(string, ...any) {}
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if len(cfg.PCRs) == 0 {
		cfg.PCRs = []int{0, 1, 2, 3, 4, 5, 6, 7}
	}

	ldevid, err := readNVCert(rw, protocol.NVLDevIDCert)
	if err != nil {
		return nil, err
	}
	if ldevid == nil {
		return nil, ErrNoLDevID
	}
	lak, err := readNVCert(rw, protocol.NVLAKCert)
	if err != nil {
		return nil, err
	}
	if lak == nil {
		return nil, fmt.Errorf("no LAK certificate at NV %#x", protocol.NVLAKCert)
	}
	if left := ldevid.NotAfter.Sub(cfg.Now()); left > cfg.RenewBefore {
		logf("LDevID %x expires %s, in %s: not due", ldevid.SerialNumber, ldevid.NotAfter.Format(time.RFC3339), left.Round(time.Hour))
		return &RenewResult{NotAfter: ldevid.NotAfter}, nil
	}
	logf("LDevID %x expires %s: renewing", ldevid.SerialNumber, ldevid.NotAfter.Format(time.RFC3339))

	hc := Config{BaseURL: cfg.BaseURL, HTTP: cfg.HTTP}
	var devid protocol.DevID
	if err := get(ctx, hc, strings.Replace(protocol.PathDevID, "{serial}", url.PathEscape(cfg.Serial), 1), &devid); err != nil {
		return nil, fmt.Errorf("LDevID lookup: %w", err)
	}
	if err := sameKey(devid.AKPublic, lak.PublicKey); err != nil {
		return nil, fmt.Errorf("the service's AK blob is not the LAK in NV: %w", err)
	}
	if err := sameKey(devid.LDevIDPublic, ldevid.PublicKey); err != nil {
		return nil, fmt.Errorf("the service's LDevID blob is not the LDevID in NV: %w", err)
	}

	var started protocol.RenewStart
	if err := post(ctx, hc, protocol.PathRenew, protocol.RenewRequest{Serial: cfg.Serial}, &started); err != nil {
		return nil, err
	}
	logf("renewal session %s", started.Session)

	evidence, err := renewEvidence(rw, devid, started.Nonce, cfg.PCRs)
	if err != nil {
		return nil, err
	}
	evidence.EventLog = cfg.EventLog
	var renewed protocol.Renewed
	if err := post(ctx, hc, strings.Replace(protocol.PathRenewEvidence, "{session}", started.Session, 1), evidence, &renewed); err != nil {
		return nil, err
	}

	next, err := leafOf(renewed.LDevIDCert, ldevid.PublicKey)
	if err != nil {
		return nil, fmt.Errorf("renewed LDevID: %w", err)
	}
	if !next.NotAfter.After(ldevid.NotAfter) {
		return nil, fmt.Errorf("renewed LDevID expires %s, no later than the one in NV", next.NotAfter.Format(time.RFC3339))
	}
	if err := writeNV(rw, protocol.NVLDevIDCert, next.Raw); err != nil {
		return nil, fmt.Errorf("store the LDevID at NV %#x: %w", protocol.NVLDevIDCert, err)
	}
	logf("LDevID %x stored at NV %#x, expires %s", next.SerialNumber, protocol.NVLDevIDCert, next.NotAfter.Format(time.RFC3339))
	if renewed.LAKCert != "" {
		nextLAK, err := leafOf(renewed.LAKCert, lak.PublicKey)
		if err != nil {
			return nil, fmt.Errorf("renewed LAK: %w", err)
		}
		if err := writeNV(rw, protocol.NVLAKCert, nextLAK.Raw); err != nil {
			return nil, fmt.Errorf("store the LAK at NV %#x: %w", protocol.NVLAKCert, err)
		}
		logf("LAK %x stored at NV %#x", nextLAK.SerialNumber, protocol.NVLAKCert)
	}
	return &RenewResult{Renewed: true, NotAfter: next.NotAfter}, nil
}

// renewEvidence loads the LAK and the LDevID key from their blobs, quotes the
// PCRs with the LAK and certifies the LDevID key with it, both qualified by
// the nonce.
func renewEvidence(rw io.ReadWriter, devid protocol.DevID, nonce []byte, pcrs []int) (protocol.RenewEvidence, error) {
	var out protocol.RenewEvidence
	srk, _, err := tpm2.CreatePrimary(rw, tpm2.HandleOwner, tpm2.PCRSelection{}, "", "", SRKTemplate)
	if err != nil {
		return out, fmt.Errorf("create SRK: %w", err)
	}
	ak, _, err := tpm2.Load(rw, srk, "", devid.AKPublic, devid.AKPrivate)
	if err != nil {
		_ = tpm2.FlushContext(rw, srk)
		return out, fmt.Errorf("load the LAK: %w", err)
	}
	defer tpm2.FlushContext(rw, ak)
	ld, _, err := tpm2.Load(rw, srk, "", devid.LDevIDPublic, devid.LDevIDPrivate)
	_ = tpm2.FlushContext(rw, srk)
	if err != nil {
		return out, fmt.Errorf("load the LDevID key: %w", err)
	}
	defer tpm2.FlushContext(rw, ld)

	quote, sig, err := tpm2.Quote(rw, ak, "", "", nonce, tpm2.PCRSelection{Hash: tpm2.AlgSHA256, PCRs: pcrs}, tpm2.AlgNull)
	if err != nil {
		return out, fmt.Errorf("quote: %w", err)
	}
	rawSig, err := sig.Encode()
	if err != nil {
		return out, err
	}
	out.Quote = protocol.Quote{Quote: quote, Signature: rawSig}
	values, err := readPCRs(rw, pcrs)
	if err != nil {
		return out, err
	}
	for _, i := range pcrs {
		out.PCRs = append(out.PCRs, protocol.PCR{Index: i, Digest: values[i]})
	}
	attest, certSig, err := tpm2.CertifyEx(rw, "", "", ld, ak, nonce, *AKTemplate.ECCParameters.Sign)
	if err != nil {
		return out, fmt.Errorf("certify the LDevID key: %w", err)
	}
	out.LDevID = protocol.Certified{Public: devid.LDevIDPublic, Attestation: attest, Signature: certSig}
	return out, nil
}

// readNVCert reads the DER certificate at an NV index, or nil when the index
// is not defined.
func readNVCert(rw io.ReadWriter, index uint32) (*x509.Certificate, error) {
	if _, err := tpm2.NVReadPublic(rw, tpmutil.Handle(index)); err != nil {
		return nil, nil
	}
	b, err := readNV(rw, tpmutil.Handle(index))
	if err != nil {
		return nil, fmt.Errorf("read NV %#x: %w", index, err)
	}
	cert, err := x509.ParseCertificate(trimDER(b))
	if err != nil {
		return nil, fmt.Errorf("NV %#x: %w", index, err)
	}
	return cert, nil
}

// sameKey checks that a TPMT_PUBLIC blob holds the public key want.
func sameKey(blob []byte, want crypto.PublicKey) error {
	pub, err := tpm2.DecodePublic(blob)
	if err != nil {
		return err
	}
	key, err := pub.Key()
	if err != nil {
		return err
	}
	got, err := x509.MarshalPKIXPublicKey(key)
	if err != nil {
		return err
	}
	w, err := x509.MarshalPKIXPublicKey(want)
	if err != nil {
		return err
	}
	if !bytes.Equal(got, w) {
		return errors.New("the keys differ")
	}
	return nil
}

// leafOf parses the first certificate of a PEM chain and checks that it
// certifies want.
func leafOf(chain string, want crypto.PublicKey) (*x509.Certificate, error) {
	block, _ := pem.Decode([]byte(chain))
	if block == nil || block.Type != "CERTIFICATE" {
		return nil, errors.New("no PEM certificate")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil, err
	}
	got, _ := x509.MarshalPKIXPublicKey(cert.PublicKey)
	w, err := x509.MarshalPKIXPublicKey(want)
	if err != nil {
		return nil, err
	}
	if !bytes.Equal(got, w) {
		return nil, errors.New("it certifies another key")
	}
	return cert, nil
}

func get(ctx context.Context, cfg Config, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSuffix(cfg.BaseURL, "/")+path, nil)
	if err != nil {
		return err
	}
	client := cfg.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s: %s", path, resp.Status)
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(out)
}
