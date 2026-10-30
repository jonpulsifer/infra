package main

import (
	"bytes"
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/subtle"
	"crypto/x509"
	"encoding/hex"
	"errors"
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

// Verifier runs the attestation: EK chain and inventory at start, then
// credential activation, quote, event-log policy and the LDevID's
// certification at evidence, then issue. A renewal from the running node
// repeats the quote and the policy against the LAK on file.
type Verifier struct {
	// Inventory is machines.yaml: the only source without NetBox, and the
	// source of a pin or a class NetBox lacks with it.
	Inventory *Inventory
	// NetBox, when set, is the system of record: it names the machine, its
	// class and its lifecycle, and gets a device for a serial it never saw.
	NetBox     *NetBox
	Roots      *EKRoots
	Policy     *Policy
	CA         *CA
	Store      *Store
	Recorders  []Recorder
	Audit      *Audit
	Log        *slog.Logger
	Now        func() time.Time
	SessionTTL time.Duration
	// IntakePerHour caps the NetBox devices created on first sight; 10 when zero.
	IntakePerHour int
	// OnChange runs after any record changes, to refresh the metrics file.
	OnChange func()
	// Fleet, when set, renders an intake pass's Talos config under an
	// install code that the confirm answers.
	Fleet *FleetRender
	// Intake, when set, is the intake policy and the owner's window. Under
	// declared, a planned stub with no MAC binds to the box that attests as
	// its serial; under open, within the window, a serial NetBox does not
	// know passes as a planned device does.
	Intake *IntakeWindow

	mu       sync.Mutex
	sessions map[string]*session
	verdicts map[[2]string]uint64
	checks   map[[2]string]checkCount
	intakes  map[string]time.Time
	creating map[string]*sync.Mutex
}

type session struct {
	machine  Machine
	claim    protocol.Machine
	eks      []VerifiedEK
	akPublic []byte
	ak       *attest.AKPublic
	nonce    []byte
	secrets  map[string][]byte
	expires  time.Time
	passed   bool
	passedAt time.Time
	// A renewal's session carries the record it renews and the blobs on
	// file, which it keeps serving, instead of EKs and secrets.
	renew   *Record
	akBlobs protocol.Blobs
	ldBlobs protocol.Blobs
	// check is a renewal session opened for the daily check, which issues
	// nothing; ldevidIssued is the LDevID on file's CA-signed issue time;
	// devidFiles are the verified DevID's files, set when this anchor holds
	// no record under the machine's name.
	check        bool
	ldevidIssued time.Time
	devidFiles   map[string][]byte
	// intakeUntil is when the window that admitted an unknown serial under
	// the open policy closes; bind is a declared stub the pass binds to;
	// planned is a planned device that passes on its EK certificates alone,
	// looked up again before anything is issued.
	intakeUntil time.Time
	bind        bool
	planned     bool
	// created is whether this session's first sight made the device;
	// macWritten whether its binding wrote the stub's MAC.
	created    bool
	macWritten bool
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
	if !validSerial(req.Machine.Serial) {
		return protocol.StartResponse{}, v.reject(nil, req.Machine, fail(reasonSerial, "the serial must be 1 to 64 printable ASCII characters"))
	}
	req.Machine.Serial = serialKey(req.Machine.Serial)
	m, ok, err := v.lookupMachine(ctx, req.Machine.Serial)
	if err != nil {
		return protocol.StartResponse{}, v.reject(nil, req.Machine, err)
	}
	// The open window speaks only for a serial no source knows; for a known
	// one it changes no outcome. Under the declared policy the planned stub
	// the owner declared is the authorization, and the pass binds the box's
	// MAC to it.
	var intakeUntil time.Time
	window, bind := false, false
	if !ok && v.NetBox != nil {
		intakeUntil, window = v.intakeOpen(now, intakePolicyOpen)
	} else if ok && v.Intake != nil && v.Intake.Policy == intakePolicyDeclared && m.FromNetBox && m.NetBoxID != 0 && strings.EqualFold(m.Status, statusPlanned) {
		bind = true
	}
	if !ok {
		if v.NetBox == nil {
			return protocol.StartResponse{}, v.reject(nil, req.Machine, fail(reasonUnknownMachine, "no inventory machine has serial %q", req.Machine.Serial))
		}
		// NetBox answered that it has no such device. Nothing is created
		// for a claim: the device comes into being once the machine's TPM
		// activates a credential, in Evidence.
		m = Machine{Name: intakeName(req.Machine), Serial: req.Machine.Serial, FromNetBox: true}
	}
	if m.blocked() {
		return protocol.StartResponse{}, v.reject(&m, req.Machine, fail(reasonStatus, "%s is %s and gets no identity; the owner changes that in NetBox", m.Name, m.Status))
	}
	if m.MAC != "" && normalMAC(req.Machine.MAC) != normalMAC(m.MAC) {
		return protocol.StartResponse{}, v.reject(&m, req.Machine, fail(reasonMACMismatch, "MAC %q is not %s's", req.Machine.MAC, m.Name))
	}
	// A session that may write the claimed MAC to NetBox, on first sight or
	// a stub's binding, needs one that reads as a MAC; a binding needs one.
	if mac := req.Machine.MAC; ((!ok && v.NetBox != nil) && mac != "" || bind) && !validMAC(mac) {
		return protocol.StartResponse{}, v.reject(&m, req.Machine, fail(reasonMACInvalid, "MAC %q does not read as six colon-separated hex bytes", mac))
	}
	if len(req.EKs) == 0 || len(req.EKs) > 2 {
		return protocol.StartResponse{}, v.reject(&m, req.Machine, fail(reasonEKMissing, "%d EKs; send the RSA EK, the ECC EK or both", len(req.EKs)))
	}
	var eks []VerifiedEK
	for _, e := range req.EKs {
		ek, err := v.Roots.Verify(e, now)
		if err != nil {
			return protocol.StartResponse{}, v.reject(&m, req.Machine, err)
		}
		if slices.ContainsFunc(eks, func(o VerifiedEK) bool { return o.Alg == ek.Alg }) {
			return protocol.StartResponse{}, v.reject(&m, req.Machine, fail(reasonEKMissing, "two %s EKs", ek.Alg))
		}
		eks = append(eks, ek)
	}
	admitted, err := v.admitPins(ctx, m, req.Machine, eks, window)
	if err != nil {
		return protocol.StartResponse{}, err
	}
	if admitted {
		// The controller binds a window's device by this name.
		m.Name = "intake-" + serialSlug(req.Machine.Serial)
	} else {
		intakeUntil = time.Time{}
	}

	akPub, err := attest.ParseAKPublic(req.AK.Public)
	if err != nil {
		return protocol.StartResponse{}, v.reject(&m, req.Machine, fail(reasonAK, "AK public: %v", err))
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

		intakeUntil: intakeUntil,
		bind:        bind,
		planned:     ok && m.FromNetBox && m.NetBoxID != 0 && strings.EqualFold(m.Status, statusPlanned) && len(m.Pins) == 0,
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
			return protocol.StartResponse{}, v.reject(&m, req.Machine, fail(reasonAK, "%v", err))
		}
		s.secrets[ek.Hash] = secret
		resp.Challenges = append(resp.Challenges, protocol.Challenge{EKHash: ek.Hash, Credential: ec.Credential, Secret: ec.Secret})
	}
	resp.Session = v.open(s)
	v.Log.Info("attestation started", "machine", m.Name, "class", m.Class, "status", m.Status, "eks", ekSummary(eks), "uuid", req.Machine.UUID)
	return resp, nil
}

// admitIntake counts a first-sight device creation against IntakePerHour,
// by the EK that activated a credential, and reports whether this one may
// go ahead. A TPM that retries within the hour spends nothing more; a
// request that never activated spends nothing at all.
func (v *Verifier) admitIntake(now time.Time, ekHash string) bool {
	limit := v.IntakePerHour
	if limit <= 0 {
		limit = 10
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.intakes == nil {
		v.intakes = map[string]time.Time{}
	}
	for h, t := range v.intakes {
		if now.Sub(t) >= time.Hour {
			delete(v.intakes, h)
		}
	}
	if _, seen := v.intakes[ekHash]; seen {
		return true
	}
	if len(v.intakes) >= limit {
		return false
	}
	v.intakes[ekHash] = now
	return true
}

// pend keeps a first intake's claim for the owner to approve, apart from
// the machine records: a claim proved nothing, so it never writes or
// replaces an identity. NetBox is told only when the device has no pass.
func (v *Verifier) pend(ctx context.Context, m Machine, claim protocol.Machine, eks []VerifiedEK, err error) error {
	var f *Failure
	if !errors.As(err, &f) {
		return err
	}
	p := Pending{Serial: m.Serial, Machine: m.Name, MAC: normalMAC(claim.MAC), UUID: claim.UUID, EKHashes: map[string]string{}, Detail: f.Detail, UpdatedAt: v.Now()}
	for _, e := range eks {
		p.EKHashes[e.Alg] = e.Hash
		if e.Issuer != "" && !slices.Contains(p.EKIssuers, e.Issuer) {
			p.EKIssuers = append(p.EKIssuers, e.Issuer)
		}
	}
	if serr := v.Store.SavePending(p); serr != nil {
		v.Log.Error("record pending claim", "serial", m.Serial, "err", serr)
	}
	v.Log.Warn("first intake waits for approval", "machine", m.Name, "serial", m.Serial, "eks", ekSummary(eks))
	v.count(protocol.VerdictPending, f.Reason)
	v.Audit.Emit(AuditEntry{Event: auditVerdict, Node: m.Name, Serial: m.Serial, Class: m.Class, Status: protocol.VerdictPending, Reason: f.Error()})
	if jerr := v.Store.Journal(map[string]any{"time": v.Now(), "machine": m.Name, "serial": m.Serial, "mac": claim.MAC, "verdict": protocol.VerdictPending, "reason": f.Reason, "detail": f.Detail, "ek_hashes": p.EKHashes}); jerr != nil {
		v.Log.Error("journal", "err", jerr)
	}
	if v.NetBox != nil && m.NetBoxID != 0 {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
		if nerr := v.NetBox.MarkPending(ctx, m.Serial, f.Detail); nerr != nil {
			v.Log.Warn("NetBox pending note", "serial", m.Serial, "err", nerr)
		}
		cancel()
	}
	v.changed()
	return f
}

// confirmWindow is how long a passed session outlives a newer session of the
// same machine, so a fresh start cannot take a pass's confirm away.
const confirmWindow = 5 * time.Minute

// open registers a session under a fresh id, dropping expired ones and any
// older session of the same machine, except one that passed within
// confirmWindow and waits for its confirm.
func (v *Verifier) open(s *session) string {
	id := hex.EncodeToString(v.random(16))
	now := v.Now()
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.sessions == nil {
		v.sessions = map[string]*session{}
	}
	for old, o := range v.sessions {
		waiting := o.passed && now.Sub(o.passedAt) < confirmWindow
		if now.After(o.expires) || (o.machine.Name == s.machine.Name && !waiting) {
			delete(v.sessions, old)
		}
	}
	v.sessions[id] = s
	return id
}

// checkPinned matches the EKs against the hashes NetBox or git pins, or
// against the owner's approval on first intake. A planned machine, one the
// owner ordered and entered before it arrived, needs no approval when every
// EK carries a manufacturer certificate: the supply chain vouches for it,
// and the pass writes its hashes as the pins. Every EK still has to pass
// activation. Within an open window, window says the serial is one no
// source knows, which the supply chain then vouches for as for a planned
// machine; the answer says whether the window admitted it.
func (v *Verifier) checkPinned(m Machine, eks []VerifiedEK, window bool) (bool, error) {
	if len(m.Pins) > 0 {
		return false, matchPins(m, eks)
	}
	a, err := v.Store.Approvals()
	if err != nil {
		return false, fmt.Errorf("approvals: %w", err)
	}
	approved := map[string]bool{}
	for _, h := range a[serialKey(m.Serial)] {
		approved[h] = true
	}
	planned := m.FromNetBox && strings.EqualFold(m.Status, statusPlanned)
	if len(approved) == 0 && planned && v.stubWaitsForWindow(v.Now()) {
		return false, fail(reasonEKPending, "%s is planned, but declared stubs pass only while the intake window is open; open it with mise run fleet:intake open, or approve %s", m.Name, ekSummary(eks))
	}
	if len(approved) == 0 && (planned || window) {
		why := "is planned"
		if !planned {
			why = "is unknown to NetBox in the open intake window"
		}
		for _, ek := range eks {
			if ek.Issuer == "" {
				return false, fail(reasonEKPending, "%s %s, but its %s EK has no manufacturer certificate; approve %s on first intake", m.Name, why, ek.Alg, ekSummary(eks))
			}
		}
		v.Log.Info("machine admitted by its EK certificates", "machine", m.Name, "planned", planned, "window", !planned, "eks", ekSummary(eks))
		return !planned, nil
	}
	if len(approved) == 0 {
		return false, fail(reasonEKPending, "%s has no EK hash on record; approve %s on first intake", m.Name, ekSummary(eks))
	}
	// Approved hashes are pins: another EK is a mismatch, not a new claim.
	for _, ek := range eks {
		if !approved[ek.Hash] {
			return false, fail(reasonEKHash, "%s EK %s is not among %s's approved hashes", ek.Alg, ek.Hash, m.Name)
		}
	}
	return false, nil
}

// admitPins applies checkPinned, keeping a first intake's wait apart from
// the machine records, as the claim it is, for the owner to approve. Nothing
// proved any of these refusals came from the machine, so none touches a
// record.
func (v *Verifier) admitPins(ctx context.Context, m Machine, claim protocol.Machine, eks []VerifiedEK, window bool) (bool, error) {
	admitted, err := v.checkPinned(m, eks, window)
	if err == nil {
		return admitted, nil
	}
	if reasonOf(err) == reasonEKPending {
		return false, v.pend(ctx, m, claim, eks, err)
	}
	return false, v.reject(&m, claim, err)
}

// recheck applies the start's rules to a device NetBox holds now: its
// lifecycle, its MAC and its pins, with no window, since the window never
// speaks for a known device.
func (v *Verifier) recheck(ctx context.Context, m Machine, claim protocol.Machine, eks []VerifiedEK) error {
	// First sight issues only to a device in intake: an active node is
	// never re-issued because its serial appeared during a session.
	if st := strings.ToLower(m.Status); st != statusPlanned && st != statusStaged {
		return v.reject(&m, claim, fail(reasonStatus, "%s is %s, which first sight never issues to; attest it again", m.Name, m.Status))
	}
	if m.MAC != "" && normalMAC(claim.MAC) != normalMAC(m.MAC) {
		return v.reject(&m, claim, fail(reasonMACMismatch, "MAC %q is not %s's", claim.MAC, m.Name))
	}
	_, err := v.admitPins(ctx, m, claim, eks, false)
	return err
}

// matchPins checks the EKs against the hashes the record pins: each pinned
// algorithm sent with its hash, and no other EK without a certificate.
func matchPins(m Machine, eks []VerifiedEK) error {
	pinned := m.Pins
	for alg, want := range pinned {
		i := slices.IndexFunc(eks, func(e VerifiedEK) bool { return e.Alg == alg })
		if i < 0 {
			return fail(reasonEKMissing, "the record pins %s's %s EK, which was not sent", m.Name, alg)
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

// peekSession finds a session without taking it, so a request that fails its
// checks leaves the session for the machine that owns it.
func (v *Verifier) peekSession(id string, passed bool) (*session, bool) {
	v.mu.Lock()
	defer v.mu.Unlock()
	s, ok := v.sessions[id]
	if !ok || v.Now().After(s.expires) || s.passed != passed {
		return nil, false
	}
	return s, true
}

// takeSession removes a session so no two requests use it at once; a pass
// puts it back for the confirm. A session in the other state stays: a
// request for the wrong route never removes it.
func (v *Verifier) takeSession(id string, passed bool) (*session, bool) {
	v.mu.Lock()
	defer v.mu.Unlock()
	s, ok := v.sessions[id]
	if !ok {
		return nil, false
	}
	if v.Now().After(s.expires) {
		delete(v.sessions, id)
		return nil, false
	}
	if s.passed != passed {
		return nil, false
	}
	delete(v.sessions, id)
	return s, true
}

// Evidence checks the activation answers, the quote, the event log against
// the policy and the LDevID's certification, then issues both certificates.
func (v *Verifier) Evidence(ctx context.Context, id string, req protocol.EvidenceRequest) (protocol.Verdict, error) {
	s, ok := v.takeSession(id, false)
	if !ok || s.renew != nil {
		return protocol.Verdict{}, fail(reasonSession, "no open session %q", id)
	}
	refuse := func(err error) (protocol.Verdict, error) {
		return protocol.Verdict{}, v.refuse(ctx, &s.machine, s.claim, s.eks, err)
	}

	// Activation is the proof that the AK is in the TPM with the pinned EK.
	// Before it, nothing is authenticated, and a failure records nothing.
	for hash, want := range s.secrets {
		i := slices.IndexFunc(req.Activated, func(a protocol.Activated) bool { return a.EKHash == hash })
		if i < 0 || subtle.ConstantTimeCompare(req.Activated[i].Secret, want) != 1 {
			return protocol.Verdict{}, v.reject(&s.machine, s.claim, fail(reasonActivation, "the credential for EK %s was not activated", hash))
		}
	}

	// A machine NetBox never saw gets its device now, on the strength of
	// the activation, within the hour's cap of new EKs.
	if v.NetBox != nil && s.machine.NetBoxID == 0 && s.machine.FromNetBox {
		if !v.admitIntake(v.Now(), s.eks[0].Hash) {
			return protocol.Verdict{}, v.reject(&s.machine, s.claim, fail(reasonIntakeRate, "too many first-sight devices this hour; try later"))
		}
		name := ""
		if !s.intakeUntil.IsZero() {
			name = s.machine.Name
		}
		created, fresh, err := v.firstSight(ctx, s.claim, name)
		if err != nil {
			v.Log.Error("NetBox device creation", "serial", s.claim.Serial, "err", err)
			return protocol.Verdict{}, v.reject(&s.machine, s.claim, fail(reasonNetBox, "the device for serial %q could not be created in NetBox: %v", s.claim.Serial, err))
		}
		if !fresh {
			// NetBox learned the serial since the start, from the owner or
			// another anchor. The window never speaks for a known device:
			// the start's rules decide for the device NetBox holds now.
			if err := v.recheck(ctx, created, s.claim, s.eks); err != nil {
				return protocol.Verdict{}, err
			}
		} else {
			created.Pins = s.machine.Pins
		}
		s.created = fresh
		s.machine = created
	}

	pcrs, err := v.quotedPCRs(s, req.Quote, req.PCRs)
	if err != nil {
		// A machine with no pin yet, planned or on first sight, is not the
		// TPM's to quarantine until its quote verifies.
		if len(s.machine.Pins) == 0 && !v.approvedBefore(s.machine.Serial) {
			return protocol.Verdict{}, v.reject(&s.machine, s.claim, err)
		}
		return refuse(err)
	}
	events, err := v.replayBoot(pcrs, req.EventLog, v.Policy.Evaluate)
	if err != nil {
		return refuse(err)
	}
	ldevid, err := v.checkLDevID(s, req.LDevID, req.LDevIDBlobs)
	if err != nil {
		return refuse(err)
	}
	if !bytes.Equal(req.AKBlobs.Public, s.akPublic) || len(req.AKBlobs.Private) == 0 {
		return refuse(fail(reasonLDevID, "the AK blobs are not the activated AK"))
	}
	// A planned device is looked up again before anything is issued, and a
	// declared stub bound, only while it is still the device the start
	// admitted.
	if s.bind || s.planned {
		m, err := v.confirmPlanned(ctx, s)
		if err != nil {
			return protocol.Verdict{}, v.reject(&s.machine, s.claim, err)
		}
		s.machine = m
	}

	now := v.Now()
	ldevidCert, lakCert, err := v.issue(ldevid, s.ak.Public, s.machine, now)
	if err != nil {
		return protocol.Verdict{}, err
	}
	rec := v.baseRecord(s.machine, s.claim, s.eks)
	rec.Status = StatusAttested
	rec.EKProven = true
	rec.LDevIDSerial = serialHex(ldevidCert)
	rec.LDevIDNotAfter = ldevidCert.NotAfter
	rec.LDevIDNotBefore = ldevidCert.NotBefore
	rec.LAKSerial = serialHex(lakCert)
	rec.AttestedAt = now
	rec.BootApplications = bootApplications(events)
	rec.Network = v.attestedNetwork(ctx, s, req)
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
	// The pass proved the serial's TPM: one serial has one record, and no
	// claim waits for it any longer.
	if err := v.Store.RetireOthers(s.machine.Serial, s.machine.Name); err != nil {
		v.Log.Warn("retire old records", "machine", s.machine.Name, "err", err)
	}
	if err := v.Store.ClearPending(s.machine.Serial); err != nil {
		v.Log.Warn("clear pending claim", "machine", s.machine.Name, "err", err)
	}
	if len(s.machine.Pins) == 0 {
		// A planned machine's first pass pins it, so the pass stands even
		// when NetBox's write is late.
		hashes := make([]string, 0, len(rec.EKHashes))
		for _, h := range rec.EKHashes {
			hashes = append(hashes, h)
		}
		if err := v.Store.Approve(s.machine.Serial, hashes); err != nil {
			v.Log.Warn("record pins", "machine", s.machine.Name, "err", err)
		}
	}
	if !s.intakeUntil.IsZero() || s.bind {
		v.intakePass(s)
	}
	v.mu.Lock()
	s.passed = true
	s.passedAt = v.Now()
	v.sessions[id] = s
	v.mu.Unlock()
	v.finish(ctx, rec, protocol.VerdictPass, "", nil)
	chain := make([][]byte, 0, len(v.CA.Chain))
	for _, c := range v.CA.Chain {
		chain = append(chain, c.Raw)
	}
	return protocol.Verdict{Verdict: protocol.VerdictPass, LDevIDCert: ldevidCert.Raw, LAKCert: lakCert.Raw, Chain: chain}, nil
}

// confirmPlanned looks the planned device up again and, under the declared
// policy, binds the box to it. It is refused when the device is no longer
// planned, when it has no pins and stubs need the window and it closed, when
// a MAC on file is not the claim's, when pins on file are not these EKs, or
// when the MAC cannot be written; across anchors, the first box to bind a
// stub holds it.
func (v *Verifier) confirmPlanned(ctx context.Context, s *session) (Machine, error) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
	defer cancel()
	m, ok, err := v.lookupMachine(ctx, s.claim.Serial)
	if err != nil {
		return Machine{}, err
	}
	if !ok || m.NetBoxID != s.machine.NetBoxID || !strings.EqualFold(m.Status, statusPlanned) {
		return Machine{}, fail(reasonStatus, "%s is no longer the planned stub this session started for; attest again", s.machine.Name)
	}
	if len(m.Pins) == 0 && v.stubWaitsForWindow(v.Now()) {
		return Machine{}, fail(reasonStatus, "the intake window closed during the session; open it and attest again")
	}
	if m.MAC != "" && normalMAC(m.MAC) != normalMAC(s.claim.MAC) {
		return Machine{}, fail(reasonMACMismatch, "%s is bound to MAC %s, not %q", m.Name, m.MAC, s.claim.MAC)
	}
	if len(m.Pins) > 0 {
		if err := matchPins(m, s.eks); err != nil {
			return Machine{}, err
		}
	}
	if !s.bind {
		return m, nil
	}
	wrote, err := v.NetBox.Bind(ctx, m.NetBoxID, s.claim)
	if errors.Is(err, errMACTaken) {
		return Machine{}, fail(reasonMACMismatch, "%s: %v", m.Name, err)
	}
	if err != nil {
		return Machine{}, fail(reasonNetBox, "bind %s to MAC %s: %v", m.Name, normalMAC(s.claim.MAC), err)
	}
	s.macWritten = wrote
	return m, nil
}

// intakePass audits an intake pass: a declared stub's binding, or a pass
// the open window granted, including one for a device NetBox learned of
// during the session.
func (v *Verifier) intakePass(s *session) {
	policy, reason := intakePolicyOpen, "created at staged"
	switch {
	case s.bind && s.macWritten:
		policy, reason = intakePolicyDeclared, "bound to the declared stub; MAC written"
	case s.bind:
		policy, reason = intakePolicyDeclared, "bound to the declared stub; MAC already on file"
	case !s.created:
		reason = "NetBox learned the serial during the session; passed by " + s.machine.Name + "'s own rules"
	}
	if !s.intakeUntil.IsZero() {
		reason += ", window open until " + s.intakeUntil.UTC().Format(time.RFC3339)
	}
	v.Log.Info("intake pass", "machine", s.machine.Name, "serial", s.machine.Serial, "policy", policy, "reason", reason)
	v.Audit.Emit(AuditEntry{Event: auditIntake, Node: s.machine.Name, Serial: s.machine.Serial, Class: s.machine.Class, Status: protocol.VerdictPass, Reason: reason + "; policy " + policy})
}

// firstSight creates the NetBox device for a serial NetBox never saw, once
// per serial at a time: two sessions for one machine, or two anchors' worth
// of retries landing here, look NetBox up again under the serial's lock and
// take the device the other made, which fresh reports. An empty name lets
// Create name the device.
func (v *Verifier) firstSight(ctx context.Context, claim protocol.Machine, name string) (m Machine, fresh bool, err error) {
	key := serialKey(claim.Serial)
	v.mu.Lock()
	if v.creating == nil {
		v.creating = map[string]*sync.Mutex{}
	}
	mu := v.creating[key]
	if mu == nil {
		mu = &sync.Mutex{}
		v.creating[key] = mu
	}
	v.mu.Unlock()
	mu.Lock()
	defer mu.Unlock()
	if m, ok, err := v.NetBox.Lookup(ctx, claim.Serial); err != nil {
		return Machine{}, false, err
	} else if ok {
		return m, false, nil
	}
	created, err := v.NetBox.Create(ctx, claim, name)
	if err != nil {
		return Machine{}, false, err
	}
	v.Log.Info("NetBox device created on first sight", "machine", created.Name, "serial", created.Serial, "mac", created.MAC)
	return created, true, nil
}

// BackfillNetBox writes every pass this anchor's own intake produced to a
// NetBox device whose verdict is empty, as after the verdict fields were
// created. A record from before EKProven was kept counts as this anchor's
// own when the intake's files are here; an adopted record never is.
func (v *Verifier) BackfillNetBox(ctx context.Context) {
	if v.NetBox == nil {
		return
	}
	recs, err := v.Store.Records()
	if err != nil {
		v.Log.Warn("NetBox backfill", "err", err)
		return
	}
	for _, rec := range recs {
		if ctx.Err() != nil {
			return
		}
		if rec.Status != StatusAttested || !v.ownIntake(rec) {
			continue
		}
		ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
		written, err := v.NetBox.Backfill(ctx, rec)
		cancel()
		if err != nil {
			v.Log.Warn("NetBox backfill", "machine", rec.Machine, "serial", rec.Serial, "err", err)
			continue
		}
		if written {
			v.Log.Info("NetBox verdict backfilled from this anchor's record", "machine", rec.Machine, "serial", rec.Serial, "ldevid_serial", rec.LDevIDSerial, "attested_at", rec.AttestedAt)
			v.Audit.Emit(AuditEntry{Event: auditVerdict, Node: rec.Machine, Serial: rec.Serial, Class: rec.Class, Status: "backfilled", Reason: "ldevid " + rec.LDevIDSerial})
		}
	}
}

// ownIntake is whether this anchor's own intake path wrote the record: it
// proved the EKs, or it predates that mark and holds the intake's files,
// which an adopted record, stamped with its issue time, never does.
func (v *Verifier) ownIntake(rec Record) bool {
	if rec.EKProven {
		return true
	}
	if !rec.LDevIDNotBefore.IsZero() || rec.Renewed {
		return false
	}
	return v.Store.HasFiles(rec.Machine)
}

// approvedBefore is whether the owner, or a pass, has pinned the serial's EKs here.
func (v *Verifier) approvedBefore(serial string) bool {
	a, err := v.Store.Approvals()
	return err == nil && len(a[serialKey(serial)]) > 0
}

// issue signs the LDevID and the LAK for a machine.
func (v *Verifier) issue(ldevid, ak crypto.PublicKey, m Machine, now time.Time) (*x509.Certificate, *x509.Certificate, error) {
	subject := Subject{Machine: m.Name, Serial: m.Serial, Class: m.Class}
	ldevidCert, err := v.CA.Issue(ldevid, subject, "LDevID", now)
	if err != nil {
		return nil, nil, fmt.Errorf("issue LDevID: %w", err)
	}
	lakCert, err := v.CA.Issue(ak, subject, "LAK", now)
	if err != nil {
		return nil, nil, fmt.Errorf("issue LAK: %w", err)
	}
	v.Audit.Emit(AuditEntry{Event: auditIssue, Node: m.Name, Serial: m.Serial, Class: m.Class, Status: "issued", Reason: "ldevid " + serialHex(ldevidCert) + " lak " + serialHex(lakCert)})
	return ldevidCert, lakCert, nil
}

// replayBoot replays the event log to the quoted PCRs and applies the policy
// through evaluate. The PCRs come from quotedPCRs, so the log is the TPM's
// own statement about the boot.
func (v *Verifier) replayBoot(pcrs []attest.PCR, eventLog []byte, evaluate func([]attest.Event) []string) ([]attest.Event, error) {
	log, err := attest.ParseEventLog(eventLog)
	if err != nil {
		return nil, fail(reasonEventLog, "%v", err)
	}
	events, err := log.Verify(pcrs)
	if err != nil {
		return nil, fail(reasonEventLog, "the event log does not replay to the quoted PCRs: %v", err)
	}
	if violations := evaluate(events); len(violations) > 0 {
		return nil, &Failure{Reason: reasonPolicy, Detail: strings.Join(violations, "; ")}
	}
	return events, nil
}

func (v *Verifier) quotedPCRs(s *session, quote protocol.Quote, values []protocol.PCR) ([]attest.PCR, error) {
	var pcrs []attest.PCR
	seen := map[int]bool{}
	for _, p := range values {
		if seen[p.Index] || len(p.Digest) != crypto.SHA256.Size() {
			return nil, fail(reasonQuote, "PCR %d is repeated or not SHA-256", p.Index)
		}
		seen[p.Index] = true
		pcrs = append(pcrs, attest.PCR{Index: p.Index, Digest: p.Digest, DigestAlg: crypto.SHA256})
	}
	if err := s.ak.Verify(attest.Quote{Quote: quote.Quote, Signature: quote.Signature}, pcrs, s.nonce); err != nil {
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
// key in the same TPM as the session's AK, certified for this session, and
// that the blobs the host will keep are the key it proved.
func (v *Verifier) checkLDevID(s *session, certified protocol.Certified, blobs protocol.Blobs) (crypto.PublicKey, error) {
	cp := attest.CertificationParameters{
		Public:            certified.Public,
		CreateAttestation: certified.Attestation,
		CreateSignature:   certified.Signature,
	}
	if err := cp.Verify(attest.VerifyOpts{Public: s.ak.Public, Hash: s.ak.Hash}); err != nil {
		return nil, fail(reasonLDevID, "%v", err)
	}
	att, err := tpm2.DecodeAttestationData(certified.Attestation)
	if err != nil {
		return nil, fail(reasonLDevID, "%v", err)
	}
	if !bytes.Equal(att.ExtraData, s.nonce) {
		return nil, fail(reasonLDevID, "the certification is not qualified by this session's nonce")
	}
	pub, err := tpm2.DecodePublic(certified.Public)
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
	if !bytes.Equal(blobs.Public, certified.Public) || len(blobs.Private) == 0 {
		return nil, fail(reasonLDevID, "the LDevID blobs are not the certified key")
	}
	return key, nil
}

// Confirm records that the host stored its certificates. A signature that is
// not the session's AK's is refused and leaves the session open. After an
// intake pass, with Fleet set, a signed confirm's answer carries the install
// code wrapped to the TPM once fleet-controller has rendered the config; an
// unsigned one gets no code. Without a code the pass stands.
func (v *Verifier) Confirm(ctx context.Context, id string, req protocol.ConfirmRequest) (protocol.ConfirmResponse, error) {
	s, ok := v.peekSession(id, true)
	if !ok {
		return protocol.ConfirmResponse{}, fail(reasonSession, "no passed session %q", id)
	}
	// An unsigned confirm, from a tink-attest that predates the signature,
	// still confirms but never gets a code; a signature that fails is refused.
	signed := len(req.Signature) > 0
	if signed {
		if err := confirmSigned(s, req.Signature); err != nil {
			return protocol.ConfirmResponse{}, v.reject(&s.machine, s.claim, err)
		}
	}
	if s, ok = v.takeSession(id, true); !ok {
		return protocol.ConfirmResponse{}, fail(reasonSession, "no passed session %q", id)
	}
	rec, found, err := v.Store.Record(s.machine.Name)
	if err != nil {
		return protocol.ConfirmResponse{}, err
	}
	if !found || !rec.Issued() {
		return protocol.ConfirmResponse{}, fail(reasonSession, "%s has no issued LDevID", s.machine.Name)
	}
	rec.Confirmed = true
	rec.NVIndexes = req.NVIndexes
	rec.UpdatedAt = v.Now()
	if err := v.Store.Save(rec, nil); err != nil {
		return protocol.ConfirmResponse{}, err
	}
	v.Log.Info("attestation confirmed", "machine", rec.Machine, "nv_indexes", req.NVIndexes)
	v.record(ctx, rec)
	v.changed()
	resp := protocol.ConfirmResponse{Status: "confirmed"}
	if v.Fleet != nil && s.renew == nil && rec.EKProven {
		if !signed {
			v.withholdCode(rec, errors.New("unsigned-confirm"))
		} else if c, ok := v.installCode(ctx, rec, s); ok {
			resp.InstallCodeEKHash, resp.InstallCodeCredential, resp.InstallCodeSecret = c.EKHash, c.Credential, c.Secret
		}
	}
	return resp, nil
}

// confirmSigned checks that the session's AK signed ConfirmDigest of its
// nonce with ECDSA over SHA-256, as AKTemplate prescribes.
func confirmSigned(s *session, raw []byte) error {
	sig, err := tpm2.DecodeSignature(bytes.NewBuffer(raw))
	if err != nil || sig.Alg != tpm2.AlgECDSA || sig.ECC == nil || sig.ECC.HashAlg != tpm2.AlgSHA256 {
		return fail(reasonConfirm, "the confirm's signature is not ECDSA over SHA-256")
	}
	pub, ok := s.ak.Public.(*ecdsa.PublicKey)
	if !ok || !ecdsa.Verify(pub, protocol.ConfirmDigest(s.nonce), sig.ECC.R, sig.ECC.S) {
		return fail(reasonConfirm, "the confirm is not signed by the session's AK")
	}
	return nil
}

// RenewStart opens a renewal, or with check the daily check: a quote nonce
// for the machine whose LAK is on file. The caller resolves the DevID, from
// this anchor or a peer, since the files live where the intake ran.
func (v *Verifier) RenewStart(ctx context.Context, serial string, d protocol.DevID, check bool) (protocol.RenewStart, error) {
	m, ok, err := v.lookupMachine(ctx, serial)
	if err != nil {
		return protocol.RenewStart{}, v.reject(nil, protocol.Machine{Serial: serial}, err)
	}
	if !ok {
		return protocol.RenewStart{}, fail(reasonUnknownMachine, "no machine has serial %q", serial)
	}
	if m.blocked() {
		return protocol.RenewStart{}, v.reject(&m, protocol.Machine{Serial: m.Serial, MAC: m.MAC}, fail(reasonStatus, "%s is %s and gets no renewal; the owner changes that in NetBox", m.Name, m.Status))
	}
	// The DevID may have come from a peer over plain HTTP: nothing in it is
	// trusted until its certificates chain to this CA and name the machine,
	// and its key blobs are the keys those certificates certify.
	checked, err := v.VerifyDevID(d, m.Name, m.Serial)
	if err != nil {
		return protocol.RenewStart{}, v.reject(&m, protocol.Machine{Serial: m.Serial, MAC: m.MAC}, err)
	}
	rec, found, err := v.Store.Record(m.Name)
	if err != nil {
		return protocol.RenewStart{}, err
	}
	var devidFiles map[string][]byte
	if !found {
		// This anchor did not run the intake, or NetBox renamed the machine;
		// start a record from the DevID. Its hashes were proven elsewhere and
		// never become pins from here. A check issues nothing, so it keeps the
		// verified DevID's certificates and blobs as the record's files.
		rec = Record{
			Machine: m.Name, Serial: m.Serial, RSAEKCert: d.RSAEKCert, Confirmed: d.Confirmed, EKHashes: hashesByAlg(d),
			Status: StatusAttested, Class: m.Class, AttestedAt: d.AttestedAt,
			LDevIDSerial: serialHex(checked.LDevID), LDevIDNotAfter: checked.LDevID.NotAfter, LDevIDNotBefore: checked.LDevID.NotBefore, LAKSerial: serialHex(checked.LAK),
		}
		devidFiles = map[string][]byte{
			fileLDevIDCert: []byte(d.LDevIDCert), fileLAKCert: []byte(d.LAKCert), fileChain: []byte(d.Chain),
			fileLDevIDPub: d.LDevIDPublic, fileLDevIDPriv: d.LDevIDPrivate, fileAKPub: d.AKPublic, fileAKPriv: d.AKPrivate,
		}
	}
	rec.EKProven = false
	now := v.Now()
	s := &session{
		machine:      m,
		claim:        protocol.Machine{Serial: m.Serial, MAC: m.MAC, UUID: rec.UUID},
		akPublic:     d.AKPublic,
		ak:           checked.AK,
		nonce:        v.random(32),
		expires:      now.Add(v.SessionTTL),
		renew:        &rec,
		akBlobs:      protocol.Blobs{Public: d.AKPublic, Private: d.AKPrivate},
		ldBlobs:      protocol.Blobs{Public: d.LDevIDPublic, Private: d.LDevIDPrivate},
		check:        check,
		ldevidIssued: checked.LDevID.NotBefore,
		devidFiles:   devidFiles,
	}
	id := v.open(s)
	v.Log.Info("renewal started", "machine", m.Name, "class", m.Class, "check", check)
	return protocol.RenewStart{Session: id, Nonce: s.nonce, Check: check}, nil
}

// CheckedDevID is what VerifyDevID vouches for.
type CheckedDevID struct {
	LDevID *x509.Certificate
	LAK    *x509.Certificate
	AK     *attest.AKPublic
}

// VerifyDevID checks a DevID answer against this CA: both leaves chain to
// it and are valid now, name the machine and the serial, and keep their
// roles, the LDevID with the client-auth EKU and the LAK without; the LAK
// certifies the key in the AK blob, a restricted signing key, and the
// LDevID certifies the key in the LDevID blob, an unrestricted signing key.
func (v *Verifier) VerifyDevID(d protocol.DevID, machine, serial string) (CheckedDevID, error) {
	if d.Machine != machine || serialKey(d.Serial) != serialKey(serial) {
		return CheckedDevID{}, fail(reasonPeer, "the DevID on file names %s %s, not %s %s", d.Machine, d.Serial, machine, serial)
	}
	now := v.Now()
	ldevid, err := v.CA.VerifyLeaf(d.LDevIDCert, machine, serial, now)
	if err != nil {
		return CheckedDevID{}, fail(reasonPeer, "LDevID on file: %v", err)
	}
	if !slices.Contains(ldevid.ExtKeyUsage, x509.ExtKeyUsageClientAuth) {
		return CheckedDevID{}, fail(reasonPeer, "the LDevID on file lacks the client-auth key usage; it is not an LDevID")
	}
	lak, err := v.CA.VerifyLeaf(d.LAKCert, machine, serial, now)
	if err != nil {
		return CheckedDevID{}, fail(reasonPeer, "LAK on file: %v", err)
	}
	if len(lak.ExtKeyUsage) != 0 || len(lak.UnknownExtKeyUsage) != 0 {
		return CheckedDevID{}, fail(reasonPeer, "the LAK on file carries an extended key usage; it is not a LAK")
	}
	akPub, err := tpm2.DecodePublic(d.AKPublic)
	if err != nil {
		return CheckedDevID{}, fail(reasonPeer, "AK blob on file: %v", err)
	}
	if akPub.Attributes&tpm2.FlagRestricted == 0 || akPub.Attributes&tpm2.FlagSign == 0 || akPub.Attributes&tpm2.FlagDecrypt != 0 {
		return CheckedDevID{}, fail(reasonPeer, "the AK blob on file is not a restricted signing key")
	}
	ak, err := attest.ParseAKPublic(d.AKPublic)
	if err != nil {
		return CheckedDevID{}, fail(reasonPeer, "AK blob on file: %v", err)
	}
	if !sameKey(ak.Public, lak.PublicKey) {
		return CheckedDevID{}, fail(reasonPeer, "the AK blob on file is not the key the LAK certifies")
	}
	ldPub, err := tpm2.DecodePublic(d.LDevIDPublic)
	if err != nil {
		return CheckedDevID{}, fail(reasonPeer, "LDevID blob on file: %v", err)
	}
	if ldPub.Attributes&tpm2.FlagSign == 0 || ldPub.Attributes&tpm2.FlagRestricted != 0 || ldPub.Attributes&tpm2.FlagDecrypt != 0 {
		return CheckedDevID{}, fail(reasonPeer, "the LDevID blob on file is not an unrestricted signing key")
	}
	ldKey, err := ldPub.Key()
	if err != nil || !sameKey(ldKey, ldevid.PublicKey) {
		return CheckedDevID{}, fail(reasonPeer, "the LDevID blob on file is not the key the LDevID certifies")
	}
	return CheckedDevID{LDevID: ldevid, LAK: lak, AK: ak}, nil
}

// RenewAllowed is whether a renewal may be opened for serial at all: the
// machine must be known and not failed, retired or decommissioning. It is
// answered before any DevID is looked up, so a blocked machine gets 403.
func (v *Verifier) RenewAllowed(ctx context.Context, serial string) error {
	if !validSerial(serial) {
		return v.reject(nil, protocol.Machine{Serial: serial}, fail(reasonSerial, "the serial must be 1 to 64 printable ASCII characters"))
	}
	m, ok, err := v.lookupMachine(ctx, serial)
	if err != nil {
		return v.reject(nil, protocol.Machine{Serial: serial}, err)
	}
	if ok && m.blocked() {
		return v.reject(&m, protocol.Machine{Serial: m.Serial, MAC: m.MAC}, fail(reasonStatus, "%s is %s and gets no renewal; the owner changes that in NetBox", m.Name, m.Status))
	}
	return nil
}

func sameKey(a, b crypto.PublicKey) bool {
	da, err := x509.MarshalPKIXPublicKey(a)
	if err != nil {
		return false
	}
	db, err := x509.MarshalPKIXPublicKey(b)
	if err != nil {
		return false
	}
	return bytes.Equal(da, db)
}

// hashesByAlg reads a DevID's EK hashes by algorithm: the keyed field when
// the peer sent one, else the list in the order localDevID writes it.
func hashesByAlg(d protocol.DevID) map[string]string {
	if len(d.EKHashesByAlg) > 0 {
		return maps.Clone(d.EKHashesByAlg)
	}
	if len(d.EKHashes) == 0 {
		return nil
	}
	out := map[string]string{}
	switch {
	case len(d.EKHashes) == 2:
		out["rsa"], out["ecc"] = d.EKHashes[0], d.EKHashes[1]
	case d.RSAEKCert:
		out["rsa"] = d.EKHashes[0]
	default:
		out["ecc"] = d.EKHashes[0]
	}
	return out
}

// RenewEvidence checks a quote signed by the LAK on file and the running
// boot's event log against the renewal policy, checks that the LAK certified
// the LDevID key on file, and issues fresh LDevID and LAK certificates for
// the same keys.
func (v *Verifier) RenewEvidence(ctx context.Context, id string, req protocol.RenewEvidence) (protocol.Renewed, error) {
	s, ok := v.takeSession(id, false)
	if !ok || s.renew == nil {
		return protocol.Renewed{}, fail(reasonSession, "no open renewal %q", id)
	}
	if s.check {
		return v.check(ctx, s, req)
	}
	refuse := func(err error) (protocol.Renewed, error) {
		if s.machine.controlPlane() {
			// Failing the control plane takes the cluster's API down.
			return protocol.Renewed{}, v.failInPlace(ctx, s, err, false)
		}
		return protocol.Renewed{}, v.refuse(ctx, &s.machine, s.claim, nil, err)
	}
	// Serials are public. Until the LAK's signature over this session's nonce
	// verifies, nothing says the request came from the machine, and a failure
	// records nothing: nobody withdraws a node's identity with junk evidence.
	pcrs, err := v.quotedPCRs(s, req.Quote, req.PCRs)
	if err != nil {
		return protocol.Renewed{}, v.reject(&s.machine, s.claim, err)
	}
	events, err := v.replayBoot(pcrs, req.EventLog, v.Policy.EvaluateRenewal)
	if err != nil {
		return refuse(err)
	}
	if !bytes.Equal(req.LDevID.Public, s.ldBlobs.Public) {
		return refuse(fail(reasonLDevID, "a renewal certifies the LDevID key on file again, not another key; attest from HookOS for a new key"))
	}
	ldevid, err := v.checkLDevID(s, req.LDevID, s.ldBlobs)
	if err != nil {
		return refuse(err)
	}
	now := v.Now()
	ldevidCert, lakCert, err := v.issue(ldevid, s.ak.Public, s.machine, now)
	if err != nil {
		return protocol.Renewed{}, err
	}
	rec := *s.renew
	rec.Status = StatusAttested
	rec.Reason, rec.Detail, rec.CheckFailed = "", nil, ""
	rec.Class = s.machine.Class
	rec.LDevIDSerial = serialHex(ldevidCert)
	rec.LDevIDNotAfter = ldevidCert.NotAfter
	rec.LDevIDNotBefore = ldevidCert.NotBefore
	rec.LAKSerial = serialHex(lakCert)
	rec.AttestedAt = now
	rec.CheckedAt = now
	rec.UpdatedAt = now
	rec.Renewed = true
	rec.BootApplications = bootApplications(events)
	seen, known := v.seePCR0(ctx, s.machine.Serial, pcrs, req.BIOS)
	v.notePCR0(&rec, seen, known)
	files := map[string][]byte{
		fileLDevIDCert: v.CA.LeafPEM(ldevidCert),
		fileLAKCert:    v.CA.LeafPEM(lakCert),
		fileChain:      v.CA.ChainPEM(),
		fileLDevIDPub:  s.ldBlobs.Public,
		fileLDevIDPriv: s.ldBlobs.Private,
		fileAKPub:      s.akBlobs.Public,
		fileAKPriv:     s.akBlobs.Private,
	}
	if err := v.Store.Save(rec, files); err != nil {
		return protocol.Renewed{}, fmt.Errorf("save %s: %w", s.machine.Name, err)
	}
	v.finish(ctx, rec, protocol.VerdictPass, "", nil)
	return protocol.Renewed{LDevIDCert: string(v.CA.LeafPEM(ldevidCert)), LAKCert: string(v.CA.LeafPEM(lakCert))}, nil
}

func (v *Verifier) baseRecord(m Machine, claim protocol.Machine, eks []VerifiedEK) Record {
	r := Record{Machine: m.Name, Serial: m.Serial, UUID: claim.UUID, MAC: normalMAC(claim.MAC), Class: m.Class, Model: claim.Model, SKU: claim.SKU, BIOS: claim.BIOS, UpdatedAt: v.Now()}
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

// reject refuses a request that proved nothing yet: it is logged, counted,
// audited and journaled, and it changes no record, so nobody who merely
// knows a serial withdraws a machine's identity or fails it in NetBox. The
// answer is a refusal, not a quarantine.
func (v *Verifier) reject(m *Machine, claim protocol.Machine, err error) error {
	var f *Failure
	if !errors.As(err, &f) {
		return err
	}
	f.Unauthenticated = true
	entry := map[string]any{"time": v.Now(), "serial": claim.Serial, "mac": claim.MAC, "verdict": protocol.VerdictRefused, "reason": f.Reason, "detail": f.Detail}
	audit := AuditEntry{Event: auditVerdict, Serial: claim.Serial, Status: protocol.VerdictRefused, Reason: f.Error()}
	if m != nil {
		entry["machine"] = m.Name
		audit.Node, audit.Class = m.Name, m.Class
	}
	v.Log.Warn("request refused", "machine", audit.Node, "serial", claim.Serial, "mac", claim.MAC, "reason", f.Reason, "err", f.Detail)
	v.count(protocol.VerdictRefused, f.Reason)
	v.Audit.Emit(audit)
	if jerr := v.Store.Journal(entry); jerr != nil {
		v.Log.Error("journal", "err", jerr)
	}
	v.changed()
	return f
}

// refuse records a failed check against the machine as its quarantine, and
// returns err for the caller to send. Only a check the machine's own TPM
// signed for reaches it.
func (v *Verifier) refuse(ctx context.Context, m *Machine, claim protocol.Machine, eks []VerifiedEK, err error) error {
	return v.quarantine(ctx, m, claim, eks, err, false)
}

// quarantine is refuse, with check marking a daily check's quarantine.
func (v *Verifier) quarantine(ctx context.Context, m *Machine, claim protocol.Machine, eks []VerifiedEK, err error, check bool) error {
	reason := reasonOf(err)
	if reason == reasonInternal || reason == reasonSession {
		return err
	}
	verdict := protocol.VerdictQuarantine
	rec := v.baseRecord(*m, claim, eks)
	if prev, ok, _ := v.Store.Record(m.Name); ok {
		rec.AttestedAt = prev.AttestedAt
	}
	rec.Status = StatusQuarantined
	rec.Reason = reason
	rec.Detail = []string{err.Error()}
	rec.check = check
	if serr := v.Store.Save(rec, nil); serr != nil {
		v.Log.Error("record refusal", "machine", m.Name, "err", serr)
	}
	v.finish(ctx, rec, verdict, reason, err)
	return err
}

func (v *Verifier) finish(ctx context.Context, rec Record, verdict, reason string, err error) {
	entry := map[string]any{"time": v.Now(), "machine": rec.Machine, "serial": rec.Serial, "verdict": verdict, "ek_hashes": rec.EKHashes}
	audit := AuditEntry{Event: auditVerdict, Node: rec.Machine, Serial: rec.Serial, Class: rec.Class, Status: verdict}
	switch {
	case rec.check:
		audit.Event = auditCheck
	case rec.Renewed:
		audit.Event = auditRenew
	}
	if err != nil {
		entry["reason"] = reason
		entry["detail"] = err.Error()
		audit.Reason = err.Error()
		v.Log.Warn("attestation refused", "machine", rec.Machine, "verdict", verdict, "reason", reason, "err", err)
	} else {
		entry["ldevid_serial"] = rec.LDevIDSerial
		entry["lak_serial"] = rec.LAKSerial
		entry["boot_applications"] = rec.BootApplications
		v.Log.Info("attestation passed", "machine", rec.Machine, "renewed", rec.Renewed, "ldevid_serial", rec.LDevIDSerial, "lak_serial", rec.LAKSerial)
	}
	if jerr := v.Store.Journal(entry); jerr != nil {
		v.Log.Error("journal", "err", jerr)
	}
	v.Audit.Emit(audit)
	v.count(verdict, reason)
	v.record(ctx, rec)
	v.changed()
}

// record writes the verdict to each recorder before the machine gets its
// answer, so NetBox and the anchors agree in order. A failure is logged;
// the anchors' own newest verdict then stands, and a quarantine among them
// beats a stale pass in NetBox.
func (v *Verifier) record(ctx context.Context, rec Record) {
	for _, r := range v.Recorders {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
		if err := r.Record(ctx, rec); err != nil {
			v.Log.Warn("recorder failed", "machine", rec.Machine, "status", rec.Status, "err", err)
		}
		cancel()
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

// Approve accepts the EK hashes the owner names for a pending machine on
// first intake. The owner names them, rather than "whatever is pending",
// because a pending record is an unauthenticated claim: another machine
// could have replaced it since the owner read it.
func (v *Verifier) Approve(ctx context.Context, serial string, hashes []string, approver string) ([]string, error) {
	if !validSerial(serial) {
		return nil, fail(reasonSerial, "the serial must be 1 to 64 printable ASCII characters")
	}
	p, found, err := v.Store.Pending(serial)
	if err != nil {
		return nil, err
	}
	if !found || len(p.EKHashes) == 0 || serialKey(p.Serial) != serialKey(serial) {
		return nil, fail(reasonEKPending, "no first intake waits for serial %s", serial)
	}
	if len(hashes) == 0 {
		return nil, fail(reasonApproval, "name the EK hashes to approve, as GET /machines shows them for %s", serial)
	}
	pending := map[string]bool{}
	for _, h := range p.EKHashes {
		pending[h] = true
	}
	for i, h := range hashes {
		hashes[i] = strings.ToLower(strings.TrimSpace(h))
		if !pending[hashes[i]] {
			return nil, fail(reasonApproval, "%s is not among the EK hashes waiting for %s; read GET /machines again", hashes[i], serial)
		}
	}
	sort.Strings(hashes)
	if err := v.Store.Approve(p.Serial, hashes); err != nil {
		return nil, err
	}
	if err := v.Store.ClearPending(p.Serial); err != nil {
		v.Log.Warn("clear pending claim", "serial", p.Serial, "err", err)
	}
	v.Log.Info("first intake approved", "machine", p.Machine, "serial", p.Serial, "ek_hashes", hashes, "approver", approver)
	v.Audit.Emit(AuditEntry{Event: auditVerdict, Node: p.Machine, Serial: p.Serial, Status: "approved", Approver: approver, Reason: strings.Join(hashes, " ")})
	v.changed()
	return hashes, nil
}
