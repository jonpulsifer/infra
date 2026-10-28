package main

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"log/slog"
	"maps"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/go-attestation/attest"
	"github.com/google/go-tpm/legacy/tpm2"

	"github.com/jonpulsifer/infra/apps/talos-attest/protocol"
)

// Recorder mirrors verdicts somewhere else, such as NetBox. Calls are best
// effort: a failure is logged and never changes a verdict.
type Recorder interface {
	Record(ctx context.Context, r Record) error
}

// PinSource knows a machine's RSA EK hash outside git, as NetBox's ek_hash
// does. A failure to ask it counts as no pin, so the machine waits for the
// owner's approval rather than passing.
type PinSource interface {
	EKHash(ctx context.Context, serial string) (string, error)
}

// Verifier runs the attestation: EK chain and inventory at start, then
// credential activation, quote, event-log policy and the LDevID's
// certification at evidence, then issue.
type Verifier struct {
	Inventory  *Inventory
	Roots      *EKRoots
	Policy     *Policy
	CA         *CA
	Store      *Store
	Recorders  []Recorder
	Pins       PinSource
	Log        *slog.Logger
	Now        func() time.Time
	SessionTTL time.Duration
	// OnChange runs after any record changes, to refresh the metrics file.
	OnChange func()

	mu       sync.Mutex
	sessions map[string]*session
	verdicts map[[2]string]uint64
}

type session struct {
	machine  InventoryMachine
	claim    protocol.Machine
	eks      []VerifiedEK
	akPublic []byte
	ak       *attest.AKPublic
	nonce    []byte
	secrets  map[string][]byte
	expires  time.Time
	passed   bool
}

func (v *Verifier) random(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b
}

// Start checks the machine's claims and EKs and answers with one
// credential challenge per EK and the quote nonce.
func (v *Verifier) Start(ctx context.Context, req protocol.StartRequest) (protocol.StartResponse, error) {
	now := v.Now()
	m, ok := v.Inventory.BySerial(req.Machine.Serial)
	if !ok {
		return protocol.StartResponse{}, v.refuse(ctx, nil, req.Machine, nil, fail(reasonUnknownMachine, "no inventory machine has serial %q", req.Machine.Serial))
	}
	if m.MAC != "" && normalMAC(req.Machine.MAC) != normalMAC(m.MAC) {
		return protocol.StartResponse{}, v.refuse(ctx, &m, req.Machine, nil, fail(reasonMACMismatch, "MAC %q is not %s's", req.Machine.MAC, m.Name))
	}
	if len(req.EKs) == 0 || len(req.EKs) > 2 {
		return protocol.StartResponse{}, v.refuse(ctx, &m, req.Machine, nil, fail(reasonEKMissing, "%d EKs; send the RSA EK, the ECC EK or both", len(req.EKs)))
	}
	var eks []VerifiedEK
	for _, e := range req.EKs {
		ek, err := v.Roots.Verify(e, now)
		if err != nil {
			return protocol.StartResponse{}, v.refuse(ctx, &m, req.Machine, eks, err)
		}
		if slices.ContainsFunc(eks, func(o VerifiedEK) bool { return o.Alg == ek.Alg }) {
			return protocol.StartResponse{}, v.refuse(ctx, &m, req.Machine, eks, fail(reasonEKMissing, "two %s EKs", ek.Alg))
		}
		eks = append(eks, ek)
	}
	if err := v.checkPinned(ctx, m, eks); err != nil {
		return protocol.StartResponse{}, v.refuse(ctx, &m, req.Machine, eks, err)
	}

	akPub, err := attest.ParseAKPublic(req.AK.Public)
	if err != nil {
		return protocol.StartResponse{}, v.refuse(ctx, &m, req.Machine, eks, fail(reasonAK, "AK public: %v", err))
	}
	s := &session{
		machine:  m,
		claim:    req.Machine,
		eks:      eks,
		akPublic: req.AK.Public,
		ak:       akPub,
		nonce:    v.random(32),
		secrets:  map[string][]byte{},
		expires:  now.Add(v.SessionTTL),
	}
	resp := protocol.StartResponse{Nonce: s.nonce, Expires: s.expires}
	for _, ek := range eks {
		ap := attest.ActivationParameters{
			EK: ek.Public,
			AK: attest.AttestationParameters{
				Public:            req.AK.Public,
				CreateData:        req.AK.CreateData,
				CreateAttestation: req.AK.CreateAttestation,
				CreateSignature:   req.AK.CreateSignature,
			},
		}
		secret, ec, err := ap.Generate()
		if err != nil {
			return protocol.StartResponse{}, v.refuse(ctx, &m, req.Machine, eks, fail(reasonAK, "%v", err))
		}
		s.secrets[ek.Hash] = secret
		resp.Challenges = append(resp.Challenges, protocol.Challenge{EKHash: ek.Hash, Credential: ec.Credential, Secret: ec.Secret})
	}
	resp.Session = hex.EncodeToString(v.random(16))

	v.mu.Lock()
	defer v.mu.Unlock()
	if v.sessions == nil {
		v.sessions = map[string]*session{}
	}
	for id, old := range v.sessions {
		if now.After(old.expires) || old.machine.Name == m.Name {
			delete(v.sessions, id)
		}
	}
	v.sessions[resp.Session] = s
	v.Log.Info("attestation started", "machine", m.Name, "eks", ekSummary(eks), "uuid", req.Machine.UUID)
	return resp, nil
}

// checkPinned matches the EKs against the hashes git or NetBox pins, or
// against the owner's approval on first intake. Every EK still has to pass
// activation.
func (v *Verifier) checkPinned(ctx context.Context, m InventoryMachine, eks []VerifiedEK) error {
	pinned := m.Pinned()
	if pinned["rsa"] == "" && v.Pins != nil {
		h, err := v.Pins.EKHash(ctx, m.Serial)
		if err != nil {
			v.Log.Warn("EK pin lookup", "machine", m.Name, "err", err)
		} else if h != "" {
			pinned["rsa"] = h
		}
	}
	approved := map[string]bool{}
	if len(pinned) == 0 {
		a, err := v.Store.Approvals()
		if err != nil {
			return fmt.Errorf("approvals: %w", err)
		}
		for _, h := range a[serialKey(m.Serial)] {
			approved[h] = true
		}
		for _, ek := range eks {
			if !approved[ek.Hash] {
				return fail(reasonEKPending, "%s has no EK hash in the inventory; approve %s on first intake", m.Name, ekSummary(eks))
			}
		}
		return nil
	}
	for alg, want := range pinned {
		i := slices.IndexFunc(eks, func(e VerifiedEK) bool { return e.Alg == alg })
		if i < 0 {
			return fail(reasonEKMissing, "the inventory pins %s's %s EK, which was not sent", m.Name, alg)
		}
		if eks[i].Hash != want {
			return fail(reasonEKHash, "%s EK %s is not %s's pinned %s", alg, eks[i].Hash, m.Name, want)
		}
	}
	for _, ek := range eks {
		if ek.Issuer == "" && pinned[ek.Alg] != ek.Hash {
			return fail(reasonEKUnpinned, "the %s EK has no certificate and no pinned hash", ek.Alg)
		}
	}
	return nil
}

func ekSummary(eks []VerifiedEK) string {
	parts := make([]string, 0, len(eks))
	for _, e := range eks {
		parts = append(parts, e.Alg+":"+e.Hash)
	}
	return strings.Join(parts, " ")
}

// takeSession removes a session so no two requests use it at once; a pass
// puts it back for the confirm.
func (v *Verifier) takeSession(id string, passed bool) (*session, bool) {
	v.mu.Lock()
	defer v.mu.Unlock()
	s, ok := v.sessions[id]
	delete(v.sessions, id)
	if !ok || v.Now().After(s.expires) || s.passed != passed {
		return nil, false
	}
	return s, true
}

// Evidence checks the activation answers, the quote, the event log against
// the policy and the LDevID's certification, then issues both certificates.
func (v *Verifier) Evidence(ctx context.Context, id string, req protocol.EvidenceRequest) (protocol.Verdict, error) {
	s, ok := v.takeSession(id, false)
	if !ok {
		return protocol.Verdict{}, fail(reasonSession, "no open session %q", id)
	}
	refuse := func(err error) (protocol.Verdict, error) {
		return protocol.Verdict{}, v.refuse(ctx, &s.machine, s.claim, s.eks, err)
	}

	for hash, want := range s.secrets {
		i := slices.IndexFunc(req.Activated, func(a protocol.Activated) bool { return a.EKHash == hash })
		if i < 0 || subtle.ConstantTimeCompare(req.Activated[i].Secret, want) != 1 {
			return refuse(fail(reasonActivation, "the credential for EK %s was not activated", hash))
		}
	}

	pcrs, err := v.quotedPCRs(s, req)
	if err != nil {
		return refuse(err)
	}
	log, err := attest.ParseEventLog(req.EventLog)
	if err != nil {
		return refuse(fail(reasonEventLog, "%v", err))
	}
	events, err := log.Verify(pcrs)
	if err != nil {
		return refuse(fail(reasonEventLog, "the event log does not replay to the quoted PCRs: %v", err))
	}
	if violations := v.Policy.Evaluate(events); len(violations) > 0 {
		return refuse(&Failure{Reason: reasonPolicy, Detail: strings.Join(violations, "; ")})
	}

	ldevid, err := v.checkLDevID(s, req)
	if err != nil {
		return refuse(err)
	}

	now := v.Now()
	ldevidCert, err := v.CA.Issue(ldevid, s.machine.Name, s.machine.Serial, "LDevID", now)
	if err != nil {
		return protocol.Verdict{}, fmt.Errorf("issue LDevID: %w", err)
	}
	lakCert, err := v.CA.Issue(s.ak.Public, s.machine.Name, s.machine.Serial, "LAK", now)
	if err != nil {
		return protocol.Verdict{}, fmt.Errorf("issue LAK: %w", err)
	}
	rec := v.baseRecord(s.machine, s.claim, s.eks)
	rec.Status = StatusAttested
	rec.LDevIDSerial = serialHex(ldevidCert)
	rec.LDevIDNotAfter = ldevidCert.NotAfter
	rec.LAKSerial = serialHex(lakCert)
	rec.AttestedAt = now
	rec.BootApplications = bootApplications(events)
	files := map[string][]byte{
		fileLDevIDCert: v.CA.LeafPEM(ldevidCert),
		fileLAKCert:    v.CA.LeafPEM(lakCert),
		fileChain:      v.CA.ChainPEM(),
		fileLDevIDPub:  req.LDevIDBlobs.Public,
		fileLDevIDPriv: req.LDevIDBlobs.Private,
		fileAKPub:      req.AKBlobs.Public,
		fileAKPriv:     req.AKBlobs.Private,
	}
	if err := v.Store.Save(rec, files); err != nil {
		return protocol.Verdict{}, fmt.Errorf("save %s: %w", s.machine.Name, err)
	}
	v.mu.Lock()
	s.passed = true
	v.sessions[id] = s
	v.mu.Unlock()
	v.finish(ctx, rec, protocol.VerdictPass, "", nil)

	chain := make([][]byte, 0, len(v.CA.Chain))
	for _, c := range v.CA.Chain {
		chain = append(chain, c.Raw)
	}
	return protocol.Verdict{Verdict: protocol.VerdictPass, LDevIDCert: ldevidCert.Raw, LAKCert: lakCert.Raw, Chain: chain}, nil
}

func (v *Verifier) quotedPCRs(s *session, req protocol.EvidenceRequest) ([]attest.PCR, error) {
	var pcrs []attest.PCR
	seen := map[int]bool{}
	for _, p := range req.PCRs {
		if seen[p.Index] || len(p.Digest) != crypto.SHA256.Size() {
			return nil, fail(reasonQuote, "PCR %d is repeated or not SHA-256", p.Index)
		}
		seen[p.Index] = true
		pcrs = append(pcrs, attest.PCR{Index: p.Index, Digest: p.Digest, DigestAlg: crypto.SHA256})
	}
	if err := s.ak.Verify(attest.Quote{Quote: req.Quote.Quote, Signature: req.Quote.Signature}, pcrs, s.nonce); err != nil {
		return nil, fail(reasonQuote, "%v", err)
	}
	for _, want := range v.Policy.PCRs {
		i := slices.IndexFunc(pcrs, func(p attest.PCR) bool { return p.Index == want })
		if i < 0 || !pcrs[i].QuoteVerified() {
			return nil, fail(reasonQuote, "the quote does not cover PCR %d", want)
		}
	}
	return pcrs, nil
}

// checkLDevID proves the LDevID key is a TPM-made, non-exportable signing
// key in the same TPM as the AK, certified for this session, and that the
// blobs the host will keep are the keys it proved.
func (v *Verifier) checkLDevID(s *session, req protocol.EvidenceRequest) (crypto.PublicKey, error) {
	cp := attest.CertificationParameters{
		Public:            req.LDevID.Public,
		CreateAttestation: req.LDevID.Attestation,
		CreateSignature:   req.LDevID.Signature,
	}
	if err := cp.Verify(attest.VerifyOpts{Public: s.ak.Public, Hash: s.ak.Hash}); err != nil {
		return nil, fail(reasonLDevID, "%v", err)
	}
	att, err := tpm2.DecodeAttestationData(req.LDevID.Attestation)
	if err != nil {
		return nil, fail(reasonLDevID, "%v", err)
	}
	if !bytes.Equal(att.ExtraData, s.nonce) {
		return nil, fail(reasonLDevID, "the certification is not qualified by this session's nonce")
	}
	pub, err := tpm2.DecodePublic(req.LDevID.Public)
	if err != nil {
		return nil, fail(reasonLDevID, "%v", err)
	}
	if pub.Attributes&tpm2.FlagSign == 0 || pub.Attributes&tpm2.FlagDecrypt != 0 {
		return nil, fail(reasonLDevID, "the LDevID must be a signing key only")
	}
	if pub.Type != tpm2.AlgECC || pub.ECCParameters == nil || pub.ECCParameters.CurveID != tpm2.CurveNISTP256 {
		return nil, fail(reasonLDevID, "the LDevID must be ECC P-256")
	}
	key, err := pub.Key()
	if err != nil {
		return nil, fail(reasonLDevID, "%v", err)
	}
	if !bytes.Equal(req.LDevIDBlobs.Public, req.LDevID.Public) || len(req.LDevIDBlobs.Private) == 0 {
		return nil, fail(reasonLDevID, "the LDevID blobs are not the certified key")
	}
	if !bytes.Equal(req.AKBlobs.Public, s.akPublic) || len(req.AKBlobs.Private) == 0 {
		return nil, fail(reasonLDevID, "the AK blobs are not the activated AK")
	}
	return key, nil
}

// Confirm records that the host stored its certificates.
func (v *Verifier) Confirm(ctx context.Context, id string, req protocol.ConfirmRequest) error {
	s, ok := v.takeSession(id, true)
	if !ok {
		return fail(reasonSession, "no passed session %q", id)
	}
	rec, found, err := v.Store.Record(s.machine.Name)
	if err != nil {
		return err
	}
	if !found || !rec.Issued() {
		return fail(reasonSession, "%s has no issued LDevID", s.machine.Name)
	}
	rec.Confirmed = true
	rec.NVIndexes = req.NVIndexes
	rec.UpdatedAt = v.Now()
	if err := v.Store.Save(rec, nil); err != nil {
		return err
	}
	v.Log.Info("attestation confirmed", "machine", rec.Machine, "nv_indexes", req.NVIndexes)
	v.record(ctx, rec)
	v.changed()
	return nil
}

func (v *Verifier) baseRecord(m InventoryMachine, claim protocol.Machine, eks []VerifiedEK) Record {
	r := Record{Machine: m.Name, Serial: m.Serial, UUID: claim.UUID, MAC: normalMAC(claim.MAC), UpdatedAt: v.Now()}
	if len(eks) > 0 {
		r.EKHashes = map[string]string{}
		for _, e := range eks {
			r.EKHashes[e.Alg] = e.Hash
			if e.Issuer != "" && !slices.Contains(r.EKIssuers, e.Issuer) {
				r.EKIssuers = append(r.EKIssuers, e.Issuer)
			}
			if e.Alg == "rsa" && e.Issuer != "" {
				r.RSAEKCert = true
			}
		}
	}
	return r
}

// refuse records a failed check against the machine, when it is known, and
// returns err for the caller to send.
func (v *Verifier) refuse(ctx context.Context, m *InventoryMachine, claim protocol.Machine, eks []VerifiedEK, err error) error {
	reason := reasonOf(err)
	if reason == reasonInternal || reason == reasonSession {
		return err
	}
	verdict := protocol.VerdictQuarantine
	if reason == reasonEKPending {
		verdict = protocol.VerdictPending
	}
	if m == nil {
		v.Log.Warn("attestation refused", "serial", claim.Serial, "mac", claim.MAC, "reason", reason, "err", err)
		v.count(verdict, reason)
		_ = v.Store.Journal(map[string]any{"time": v.Now(), "serial": claim.Serial, "mac": claim.MAC, "verdict": verdict, "reason": reason, "detail": err.Error()})
		return err
	}
	rec := v.baseRecord(*m, claim, eks)
	if prev, ok, _ := v.Store.Record(m.Name); ok {
		rec.AttestedAt = prev.AttestedAt
	}
	rec.Status = StatusQuarantined
	if verdict == protocol.VerdictPending {
		rec.Status = StatusPending
	}
	rec.Reason = reason
	rec.Detail = []string{err.Error()}
	if serr := v.Store.Save(rec, nil); serr != nil {
		v.Log.Error("record refusal", "machine", m.Name, "err", serr)
	}
	v.finish(ctx, rec, verdict, reason, err)
	return err
}

func (v *Verifier) finish(ctx context.Context, rec Record, verdict, reason string, err error) {
	entry := map[string]any{"time": v.Now(), "machine": rec.Machine, "serial": rec.Serial, "verdict": verdict, "ek_hashes": rec.EKHashes}
	if err != nil {
		entry["reason"] = reason
		entry["detail"] = err.Error()
		v.Log.Warn("attestation refused", "machine", rec.Machine, "verdict", verdict, "reason", reason, "err", err)
	} else {
		entry["ldevid_serial"] = rec.LDevIDSerial
		entry["lak_serial"] = rec.LAKSerial
		entry["boot_applications"] = rec.BootApplications
		v.Log.Info("attestation passed", "machine", rec.Machine, "ldevid_serial", rec.LDevIDSerial, "lak_serial", rec.LAKSerial)
	}
	if jerr := v.Store.Journal(entry); jerr != nil {
		v.Log.Error("journal", "err", jerr)
	}
	v.count(verdict, reason)
	v.record(ctx, rec)
	v.changed()
}

func (v *Verifier) record(ctx context.Context, rec Record) {
	for _, r := range v.Recorders {
		go func() {
			ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
			defer cancel()
			if err := r.Record(ctx, rec); err != nil {
				v.Log.Warn("recorder failed", "machine", rec.Machine, "err", err)
			}
		}()
	}
}

func (v *Verifier) count(verdict, reason string) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.verdicts == nil {
		v.verdicts = map[[2]string]uint64{}
	}
	v.verdicts[[2]string{verdict, reason}]++
}

func (v *Verifier) changed() {
	if v.OnChange != nil {
		v.OnChange()
	}
}

// Verdicts returns the verdict counts by verdict and reason.
func (v *Verifier) Verdicts() map[[2]string]uint64 {
	v.mu.Lock()
	defer v.mu.Unlock()
	return maps.Clone(v.verdicts)
}

// Approve accepts a pending machine's EK hashes on first intake.
func (v *Verifier) Approve(serial string) ([]string, error) {
	m, ok := v.Inventory.BySerial(serial)
	if !ok {
		return nil, fail(reasonUnknownMachine, "no inventory machine has serial %q", serial)
	}
	rec, found, err := v.Store.Record(m.Name)
	if err != nil {
		return nil, err
	}
	if !found || rec.Status != StatusPending || len(rec.EKHashes) == 0 {
		return nil, fail(reasonEKPending, "%s is not waiting for approval", m.Name)
	}
	hashes := make([]string, 0, len(rec.EKHashes))
	for _, h := range rec.EKHashes {
		hashes = append(hashes, h)
	}
	sort.Strings(hashes)
	if err := v.Store.Approve(m.Serial, hashes); err != nil {
		return nil, err
	}
	v.Log.Info("first intake approved", "machine", m.Name, "ek_hashes", hashes)
	return hashes, nil
}
