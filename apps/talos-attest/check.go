package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"maps"
	"strings"
	"time"

	"github.com/google/go-attestation/attest"

	"github.com/jonpulsifer/infra/apps/talos-attest/protocol"
)

// pcr0Seen is what a running node's quote showed for PCR 0, beside the BIOS
// version the node reported and what NetBox holds for that version.
type pcr0Seen struct {
	BIOS   string
	PCR0   string
	OnFile string
	// Changed is a PCR 0 that differs from the one on file for the same
	// BIOS version: a change no BIOS update explains. It alerts and never
	// quarantines, since firmware settings move PCR 0 too.
	Changed bool
}

// validBIOS is whether a reported BIOS version reads as one: 1 to 64
// printable ASCII characters, spaces allowed inside. It is a claim, kept
// only after the TPM's proof, and it becomes a JSON key in NetBox.
func validBIOS(s string) bool {
	if s == "" || len(s) > 64 || strings.TrimSpace(s) != s {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < 0x20 || s[i] > 0x7e {
			return false
		}
	}
	return true
}

// seePCR0 compares the quoted PCR 0 with the one NetBox holds for the BIOS
// version the node reported. known is false when nothing can be said: no
// NetBox, a NetBox that does not answer, no pcr0_by_bios field, or no BIOS
// version in the evidence. A NetBox failure changes no verdict.
func (v *Verifier) seePCR0(ctx context.Context, serial string, pcrs []attest.PCR, bios string) (seen *pcr0Seen, known bool) {
	if v.NetBox == nil || !validBIOS(bios) {
		return nil, false
	}
	var pcr0 string
	for _, p := range pcrs {
		if p.Index == 0 && p.QuoteVerified() {
			pcr0 = hex.EncodeToString(p.Digest)
		}
	}
	if pcr0 == "" {
		return nil, false
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
	defer cancel()
	onFile, defined, err := v.NetBox.PCR0ByBIOS(ctx, serial)
	if err != nil {
		v.Log.Warn("NetBox PCR 0 lookup", "serial", serial, "err", err)
		return nil, false
	}
	if !defined {
		return nil, false
	}
	seen = &pcr0Seen{BIOS: bios, PCR0: pcr0, OnFile: onFile[bios]}
	seen.Changed = seen.OnFile != "" && !strings.EqualFold(seen.OnFile, pcr0)
	return seen, true
}

// notePCR0 puts what the quote showed for PCR 0 on the record, and audits a
// change the BIOS version does not explain. Unknown keeps the record's
// previous flag: a NetBox outage neither raises nor clears the alert.
func (v *Verifier) notePCR0(rec *Record, seen *pcr0Seen, known bool) {
	if !known {
		return
	}
	rec.pcr0 = seen
	rec.PCR0Changed = seen != nil && seen.Changed
	if seen != nil {
		rec.BIOS = seen.BIOS
	}
	if rec.PCR0Changed {
		v.Log.Warn("PCR 0 changed at the same BIOS version", "machine", rec.Machine, "bios", seen.BIOS, "pcr0", seen.PCR0, "on_file", seen.OnFile)
		v.Audit.Emit(AuditEntry{Event: auditPCR0, Node: rec.Machine, Serial: rec.Serial, Class: rec.Class, Status: "changed", Reason: "bios " + seen.BIOS + " pcr0 " + seen.PCR0 + " on file " + seen.OnFile})
	}
}

// check is the daily check: a running node's quote judged by the renewal
// policy, recorded as a pass or a quarantine, with nothing issued. The proof
// comes first. The LAK on file must sign the quote over this session's
// nonce, and certify with the same nonce the LDevID key on file; until both
// verify, nothing says the request came from the machine, and a failure is
// a refusal that records nothing, so junk, replayed or foreign evidence for
// a public serial quarantines nobody. After the proof, an event log that
// does not replay to the quoted PCRs, or a boot that misses the policy,
// quarantines the machine.
func (v *Verifier) check(ctx context.Context, s *session, req protocol.RenewEvidence) (protocol.Renewed, error) {
	unproven := func(err error) (protocol.Renewed, error) {
		v.countCheck(s.machine.Name, protocol.VerdictRefused)
		return protocol.Renewed{}, v.reject(&s.machine, s.claim, err)
	}
	pcrs, err := v.quotedPCRs(s, req.Quote, req.PCRs)
	if err != nil {
		return unproven(err)
	}
	if !bytes.Equal(req.LDevID.Public, s.ldBlobs.Public) {
		return unproven(fail(reasonLDevID, "the check certifies a key that is not the LDevID on file"))
	}
	if _, err := v.checkLDevID(s, req.LDevID, s.ldBlobs); err != nil {
		return unproven(err)
	}
	events, err := v.replayBoot(pcrs, req.EventLog, v.Policy.EvaluateRenewal)
	if err != nil {
		if s.machine.controlPlane() {
			return protocol.Renewed{}, v.failInPlace(ctx, s, err, true)
		}
		if r := reasonOf(err); r != reasonInternal && r != reasonSession {
			v.countCheck(s.machine.Name, protocol.VerdictQuarantine)
		}
		return protocol.Renewed{}, v.quarantine(ctx, &s.machine, s.claim, nil, err, true)
	}
	// The session holds the record as it stood at the start. A quarantine or
	// another LDevID since then stands: the pass writes nothing over it. The
	// one quarantine a pass replaces is the one the owner lifted before the
	// session started, still unchanged.
	if cur, ok, err := v.Store.Record(s.machine.Name); err != nil {
		return protocol.Renewed{}, err
	} else if ok {
		same := cur.Status == StatusAttested && strings.EqualFold(cur.LDevIDSerial, s.renew.LDevIDSerial)
		lifted := !s.lifted.IsZero() && cur.Status == StatusQuarantined && cur.UpdatedAt.Equal(s.lifted)
		if !same && !lifted {
			return unproven(fail(reasonStatus, "%s's record changed during the check; the newer record stands", s.machine.Name))
		}
	}
	now := v.Now()
	rec := *s.renew
	rec.Status = StatusAttested
	rec.Reason, rec.Detail, rec.CheckFailed = "", nil, ""
	rec.BootApplications = bootApplications(events)
	rec.AttestedAt, rec.CheckedAt, rec.UpdatedAt = now, now, now
	if rec.LDevIDNotBefore.IsZero() {
		// A check moves attested_at, which orders a record without one.
		rec.LDevIDNotBefore = s.ldevidIssued
	}
	rec.check = true
	seen, known := v.seePCR0(ctx, s.machine.Serial, pcrs, req.BIOS)
	v.notePCR0(&rec, seen, known)
	if err := v.Store.Save(rec, s.devidFiles); err != nil {
		return protocol.Renewed{}, err
	}
	if s.devidFiles != nil {
		// One serial has one record: one kept under an older name goes.
		if err := v.Store.RetireOthers(rec.Serial, rec.Machine); err != nil {
			v.Log.Warn("retire old records", "machine", rec.Machine, "err", err)
		}
	}
	v.countCheck(s.machine.Name, protocol.VerdictPass)
	v.finish(ctx, rec, protocol.VerdictPass, "", nil)
	return protocol.Renewed{Checked: true, AttestedAt: now}, nil
}

// checkCount is how many daily checks of a machine ended in one verdict
// since the service started, and when the newest did.
type checkCount struct {
	N    uint64
	Last time.Time
}

// failInPlace records a control-plane node's failed running quote, from a
// daily check or a renewal, after the TPM's proof: the reason goes on the
// record and on NetBox's attest_verdict as failed-no-quarantine, the device
// is journaled and talos_attest_failed_no_quarantine alerts, and its status
// and LDevID stay. Quarantining it would revoke the identity of the node
// that serves the cluster's API. Nothing is issued, and a record that is no
// longer a pass is left as it is.
func (v *Verifier) failInPlace(ctx context.Context, s *session, err error, check bool) error {
	var f *Failure
	if !errors.As(err, &f) || f.Reason == reasonInternal || f.Reason == reasonSession {
		return err
	}
	f.Unquarantined = true
	if check {
		v.countCheck(s.machine.Name, protocol.VerdictFailedNoQuarantine)
	}
	rec, ok, rerr := v.Store.Record(s.machine.Name)
	if rerr != nil {
		return rerr
	}
	if !ok {
		rec = *s.renew
	}
	if rec.Status != StatusAttested {
		v.Log.Warn("control-plane node failed attestation; its record is no longer a pass and stays", "machine", rec.Machine, "status", rec.Status, "reason", f.Reason)
		return err
	}
	rec.CheckFailed = f.Reason
	rec.Detail = []string{err.Error()}
	rec.UpdatedAt = v.Now()
	rec.check, rec.unquarantined = check, true
	if serr := v.Store.Save(rec, nil); serr != nil {
		v.Log.Error("record failed check", "machine", rec.Machine, "err", serr)
	}
	v.Log.Error("control-plane node failed attestation; not quarantined", "machine", rec.Machine, "reason", f.Reason, "err", f.Detail)
	v.finish(ctx, rec, protocol.VerdictFailedNoQuarantine, f.Reason, err)
	return err
}

// countCheck counts a daily check's verdict for the machine.
func (v *Verifier) countCheck(machine, verdict string) {
	now := v.Now()
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.checks == nil {
		v.checks = map[[2]string]checkCount{}
	}
	c := v.checks[[2]string{machine, verdict}]
	c.N++
	c.Last = now
	v.checks[[2]string{machine, verdict}] = c
}

// Checks returns the daily checks' counts by machine and verdict.
func (v *Verifier) Checks() map[[2]string]checkCount {
	v.mu.Lock()
	defer v.mu.Unlock()
	return maps.Clone(v.checks)
}
