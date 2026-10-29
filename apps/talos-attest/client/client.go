// Package client drives one attestation against talos-attest from the
// machine being attested. Every key it makes is transient; the TPM keeps
// nothing but, when asked, the two certificates in NV.
package client

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/google/go-tpm/legacy/tpm2"
	"github.com/google/go-tpm/tpmutil"

	"github.com/jonpulsifer/infra/apps/talos-attest/protocol"
)

// Config is one run's inputs.
type Config struct {
	// BaseURL is the service, such as http://10.9.0.14/attest.
	BaseURL  string
	HTTP     *http.Client
	Machine  protocol.Machine
	EventLog []byte
	// StoreNV writes the LDevID and LAK certificates to NV.
	StoreNV bool
	// PCRs to quote in the SHA-256 bank.
	PCRs []int
	Logf func(format string, args ...any)
}

// Result is what a pass leaves. InstallCode is the confirm's install code,
// empty when the service gave none; it is a secret and is never logged.
type Result struct {
	Verdict     protocol.Verdict
	NVIndexes   []uint32
	InstallCode string
}

// RefusedError is the service's refusal.
type RefusedError struct {
	Status  int
	Verdict protocol.Verdict
}

func (e *RefusedError) Error() string {
	return fmt.Sprintf("refused (%d): %s %s: %s", e.Status, e.Verdict.Verdict, e.Verdict.Reason, strings.Join(e.Verdict.Detail, "; "))
}

type ek struct {
	alg      string
	template tpm2.Public
	msg      protocol.EK
	hash     string
}

// Run attests the machine whose TPM rw reaches.
func Run(ctx context.Context, rw io.ReadWriter, cfg Config) (res *Result, err error) {
	logf := cfg.Logf
	if logf == nil {
		logf = func(string, ...any) {}
	}
	if len(cfg.PCRs) == 0 {
		cfg.PCRs = []int{0, 1, 2, 3, 4, 5, 6, 7}
	}
	// A TPM holds three transient objects at a time, so nothing stays loaded
	// that the next step does not need: EKs and the SRK are recreated, which
	// yields the same keys.
	var handles []tpmutil.Handle
	flush := func(h tpmutil.Handle) {
		_ = tpm2.FlushContext(rw, h)
		for i, o := range handles {
			if o == h {
				handles = append(handles[:i], handles[i+1:]...)
				break
			}
		}
	}
	defer func() {
		for _, h := range handles {
			_ = tpm2.FlushContext(rw, h)
		}
	}()

	eks, err := endorsementKeys(rw)
	if err != nil {
		return nil, err
	}
	for _, e := range eks {
		logf("EK %s %s (certificate: %v)", e.alg, e.hash, len(e.msg.Cert) > 0)
	}

	srk, _, err := tpm2.CreatePrimary(rw, tpm2.HandleOwner, tpm2.PCRSelection{}, "", "", SRKTemplate)
	if err != nil {
		return nil, fmt.Errorf("create SRK: %w", err)
	}
	handles = append(handles, srk)
	akPriv, akPub, akCreateData, akCreateHash, akTicket, err := tpm2.CreateKey(rw, srk, tpm2.PCRSelection{}, "", "", AKTemplate)
	if err != nil {
		return nil, fmt.Errorf("create AK: %w", err)
	}
	ldPriv, ldPub, _, _, _, err := tpm2.CreateKey(rw, srk, tpm2.PCRSelection{}, "", "", LDevIDTemplate)
	if err != nil {
		return nil, fmt.Errorf("create LDevID key: %w", err)
	}
	ak, _, err := tpm2.Load(rw, srk, "", akPub, akPriv)
	if err != nil {
		return nil, fmt.Errorf("load AK: %w", err)
	}
	handles = append(handles, ak)
	flush(srk)
	scheme := *AKTemplate.ECCParameters.Sign
	akAttest, akSig, err := tpm2.CertifyCreation(rw, "", ak, ak, nil, akCreateHash, scheme, akTicket)
	if err != nil {
		return nil, fmt.Errorf("certify AK creation: %w", err)
	}

	start := protocol.StartRequest{
		Machine: cfg.Machine,
		AK:      protocol.AK{Public: akPub, CreateData: akCreateData, CreateAttestation: akAttest, CreateSignature: akSig},
	}
	for _, e := range eks {
		start.EKs = append(start.EKs, e.msg)
	}
	var started protocol.StartResponse
	if err := post(ctx, cfg, protocol.PathStart, start, &started); err != nil {
		return nil, err
	}
	logf("session %s: %d credential challenges", started.Session, len(started.Challenges))

	evidence := protocol.EvidenceRequest{EventLog: cfg.EventLog}
	for _, c := range started.Challenges {
		i := indexOf(eks, c.EKHash)
		if i < 0 {
			return nil, fmt.Errorf("challenge for an EK this TPM did not send: %s", c.EKHash)
		}
		secret, err := activate(rw, ak, eks[i].template, c)
		if err != nil {
			return nil, fmt.Errorf("activate credential for the %s EK: %w", eks[i].alg, err)
		}
		evidence.Activated = append(evidence.Activated, protocol.Activated{EKHash: c.EKHash, Secret: secret})
	}

	sel := tpm2.PCRSelection{Hash: tpm2.AlgSHA256, PCRs: cfg.PCRs}
	quote, sig, err := tpm2.Quote(rw, ak, "", "", started.Nonce, sel, tpm2.AlgNull)
	if err != nil {
		return nil, fmt.Errorf("quote: %w", err)
	}
	rawSig, err := sig.Encode()
	if err != nil {
		return nil, err
	}
	evidence.Quote = protocol.Quote{Quote: quote, Signature: rawSig}
	values, err := readPCRs(rw, cfg.PCRs)
	if err != nil {
		return nil, err
	}
	for _, i := range cfg.PCRs {
		evidence.PCRs = append(evidence.PCRs, protocol.PCR{Index: i, Digest: values[i]})
	}

	srk, _, err = tpm2.CreatePrimary(rw, tpm2.HandleOwner, tpm2.PCRSelection{}, "", "", SRKTemplate)
	if err != nil {
		return nil, fmt.Errorf("recreate SRK: %w", err)
	}
	handles = append(handles, srk)
	ld, _, err := tpm2.Load(rw, srk, "", ldPub, ldPriv)
	if err != nil {
		return nil, fmt.Errorf("load LDevID key: %w", err)
	}
	handles = append(handles, ld)
	flush(srk)
	certAttest, certSig, err := tpm2.CertifyEx(rw, "", "", ld, ak, started.Nonce, scheme)
	if err != nil {
		return nil, fmt.Errorf("certify LDevID key: %w", err)
	}
	evidence.LDevID = protocol.Certified{Public: ldPub, Attestation: certAttest, Signature: certSig}
	evidence.LDevIDBlobs = protocol.Blobs{Public: ldPub, Private: ldPriv}
	evidence.AKBlobs = protocol.Blobs{Public: akPub, Private: akPriv}

	var verdict protocol.Verdict
	if err := post(ctx, cfg, strings.Replace(protocol.PathEvidence, "{session}", started.Session, 1), evidence, &verdict); err != nil {
		return nil, err
	}
	logf("verdict %s", verdict.Verdict)
	res = &Result{Verdict: verdict}

	if cfg.StoreNV {
		for _, w := range []struct {
			index uint32
			der   []byte
		}{{protocol.NVLDevIDCert, verdict.LDevIDCert}, {protocol.NVLAKCert, verdict.LAKCert}} {
			if err := writeNV(rw, w.index, w.der); err != nil {
				return res, fmt.Errorf("store certificate at NV %#x: %w", w.index, err)
			}
			res.NVIndexes = append(res.NVIndexes, w.index)
		}
		logf("certificates stored at NV %#x and %#x", protocol.NVLDevIDCert, protocol.NVLAKCert)
	}
	confirm := protocol.ConfirmRequest{NVIndexes: res.NVIndexes}
	var confirmed protocol.ConfirmResponse
	if err := post(ctx, cfg, strings.Replace(protocol.PathConfirm, "{session}", started.Session, 1), confirm, &confirmed); err != nil {
		return res, err
	}
	res.InstallCode = confirmed.InstallCode
	return res, nil
}

func indexOf(eks []ek, hash string) int {
	for i, e := range eks {
		if e.hash == hash {
			return i
		}
	}
	return -1
}

// endorsementKeys creates each EK whose certificate the TPM holds, ECC
// first. A TPM with no certificate sends its RSA EK alone, which the
// inventory must then pin.
func endorsementKeys(rw io.ReadWriter) ([]ek, error) {
	var out []ek
	for _, c := range []struct {
		alg  string
		nv   tpmutil.Handle
		tmpl tpm2.Public
	}{{"ecc", nvEKCertECC, EKTemplateECC}, {"rsa", nvEKCertRSA, EKTemplateRSA}} {
		cert, _ := readNV(rw, c.nv)
		if cert == nil && (len(out) > 0 || c.alg == "ecc") {
			continue
		}
		h, pub, err := tpm2.CreatePrimary(rw, tpm2.HandleEndorsement, tpm2.PCRSelection{}, "", "", c.tmpl)
		if err != nil {
			return nil, fmt.Errorf("create %s EK: %w", c.alg, err)
		}
		_ = tpm2.FlushContext(rw, h)
		der, err := x509.MarshalPKIXPublicKey(pub)
		if err != nil {
			return nil, err
		}
		e := ek{alg: c.alg, template: c.tmpl, msg: protocol.EK{Public: der, Cert: trimDER(cert)}, hash: hashHex(der)}
		out = append(out, e)
	}
	if len(out) == 0 {
		return nil, errors.New("no endorsement key")
	}
	return out, nil
}

func activate(rw io.ReadWriter, ak tpmutil.Handle, ekTemplate tpm2.Public, c protocol.Challenge) ([]byte, error) {
	if len(c.Credential) < 2 || len(c.Secret) < 2 {
		return nil, errors.New("malformed challenge")
	}
	ekHandle, _, err := tpm2.CreatePrimary(rw, tpm2.HandleEndorsement, tpm2.PCRSelection{}, "", "", ekTemplate)
	if err != nil {
		return nil, fmt.Errorf("recreate EK: %w", err)
	}
	defer tpm2.FlushContext(rw, ekHandle)
	sess, _, err := tpm2.StartAuthSession(rw, tpm2.HandleNull, tpm2.HandleNull, make([]byte, 16), nil, tpm2.SessionPolicy, tpm2.AlgNull, tpm2.AlgSHA256)
	if err != nil {
		return nil, err
	}
	defer tpm2.FlushContext(rw, sess)
	if _, _, err := tpm2.PolicySecret(rw, tpm2.HandleEndorsement, tpm2.AuthCommand{Session: tpm2.HandlePasswordSession, Attributes: tpm2.AttrContinueSession}, sess, nil, nil, nil, 0); err != nil {
		return nil, err
	}
	return tpm2.ActivateCredentialUsingAuth(rw, []tpm2.AuthCommand{
		{Session: tpm2.HandlePasswordSession, Attributes: tpm2.AttrContinueSession},
		{Session: sess, Attributes: tpm2.AttrContinueSession},
	}, ak, ekHandle, c.Credential[2:], c.Secret[2:])
}

func readPCRs(rw io.ReadWriter, pcrs []int) (map[int][]byte, error) {
	out := map[int][]byte{}
	// TPM2_PCR_Read answers at most 8 digests at a time.
	for i := 0; i < len(pcrs); i += 8 {
		chunk := pcrs[i:min(i+8, len(pcrs))]
		got, err := tpm2.ReadPCRs(rw, tpm2.PCRSelection{Hash: tpm2.AlgSHA256, PCRs: chunk})
		if err != nil {
			return nil, fmt.Errorf("read PCRs: %w", err)
		}
		for k, v := range got {
			out[k] = v
		}
	}
	for _, i := range pcrs {
		if len(out[i]) == 0 {
			return nil, fmt.Errorf("PCR %d was not read", i)
		}
	}
	return out, nil
}

func readNV(rw io.ReadWriter, index tpmutil.Handle) ([]byte, error) {
	b, err := tpm2.NVReadEx(rw, index, tpm2.HandleOwner, "", 0)
	if err != nil {
		return nil, err
	}
	return b, nil
}

// trimDER drops the padding some TPMs leave after the certificate in NV.
func trimDER(b []byte) []byte {
	if len(b) < 4 || b[0] != 0x30 {
		return b
	}
	var n int
	switch {
	case b[1] < 0x80:
		n = 2 + int(b[1])
	case b[1] == 0x81:
		n = 3 + int(b[2])
	case b[1] == 0x82:
		n = 4 + (int(b[2])<<8 | int(b[3]))
	default:
		return b
	}
	if n <= len(b) {
		return b[:n]
	}
	return b
}

func hashHex(der []byte) string {
	sum := sha256.Sum256(der)
	return hex.EncodeToString(sum[:])
}

const nvChunk = 512

// writeNV replaces an owner-written NV index with data.
func writeNV(rw io.ReadWriter, index uint32, data []byte) error {
	h := tpmutil.Handle(index)
	if _, err := tpm2.NVReadPublic(rw, h); err == nil {
		if err := tpm2.NVUndefineSpace(rw, "", tpm2.HandleOwner, h); err != nil {
			return fmt.Errorf("undefine: %w", err)
		}
	}
	attrs := tpm2.AttrOwnerWrite | tpm2.AttrOwnerRead | tpm2.AttrAuthRead | tpm2.AttrNoDA
	if err := tpm2.NVDefineSpace(rw, tpm2.HandleOwner, h, "", "", nil, attrs, uint16(len(data))); err != nil {
		return fmt.Errorf("define: %w", err)
	}
	for off := 0; off < len(data); off += nvChunk {
		end := min(off+nvChunk, len(data))
		if err := tpm2.NVWrite(rw, tpm2.HandleOwner, h, "", data[off:end], uint16(off)); err != nil {
			return fmt.Errorf("write: %w", err)
		}
	}
	got, err := tpm2.NVReadEx(rw, h, tpm2.HandleOwner, "", 0)
	if err != nil {
		return fmt.Errorf("read back: %w", err)
	}
	if !bytes.Equal(got, data) {
		return errors.New("read back differs")
	}
	return nil
}

func post(ctx context.Context, cfg Config, path string, body, out any) error {
	b, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimSuffix(cfg.BaseURL, "/")+path, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
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
		var v protocol.Verdict
		_ = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&v)
		return &RefusedError{Status: resp.StatusCode, Verdict: v}
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(out)
}
