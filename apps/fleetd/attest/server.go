package attest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/jonpulsifer/infra/apps/fleetd/protocol"
)

// Server holds the three listeners' handlers: the device flow for machines
// that netboot, the DevID lookup for cluster nodes, and the owner's admin
// API on the tailnet.
type Server struct {
	V         *Verifier
	Log       *slog.Logger
	Approvers map[string]bool
}

const maxBody = 1 << 20

func (s *Server) Public() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST "+protocol.PathStart, s.start)
	mux.HandleFunc("POST "+protocol.PathEvidence, s.evidence)
	mux.HandleFunc("POST "+protocol.PathConfirm, s.confirm)
	s.devIDRoutes(mux)
	mux.HandleFunc("GET /metrics", s.metrics)
	return mux
}

// DevIDHandler serves only the public LDevID lookups.
func (s *Server) DevIDHandler() http.Handler {
	mux := http.NewServeMux()
	s.devIDRoutes(mux)
	return mux
}

// devIDRoutes are the routes a running node reaches: the lookups, and the
// renewal, which it drives from its own TPM.
func (s *Server) devIDRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET "+protocol.PathDevID, s.devID)
	mux.HandleFunc("GET "+protocol.PathVerdict, s.verdict)
	mux.HandleFunc("GET "+protocol.PathDevID+"/{file}", s.devIDFile)
	mux.HandleFunc("POST "+protocol.PathRenew, s.renewStart)
	mux.HandleFunc("POST "+protocol.PathRenewEvidence, s.renewEvidence)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok\n")) })
}

func (s *Server) Admin() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /machines", s.machines)
	mux.HandleFunc("GET /metrics", s.metrics)
	return s.requireApprover(mux)
}

// requireApprover trusts Tailscale-User-Login because only tailscale serve
// reaches the admin socket, and it overwrites any copy a client sends.
func (s *Server) requireApprover(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		login := strings.ToLower(r.Header.Get("Tailscale-User-Login"))
		if login == "" || !s.Approvers[login] {
			s.Log.Warn("admin request refused", "login", login, "path", r.URL.Path)
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if origin := r.Header.Get("Origin"); r.Method == http.MethodPost && origin != "" {
			if u, err := url.Parse(origin); err != nil || u.Host != r.Host {
				http.Error(w, "cross-origin request refused", http.StatusForbidden)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	dec := json.NewDecoder(io.LimitReader(r.Body, maxBody))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// writeError sends a refusal as a verdict, so the action can print why.
func (s *Server) writeError(w http.ResponseWriter, err error) {
	var f *Failure
	if !errors.As(err, &f) {
		s.Log.Error("request failed", "err", err)
		writeJSON(w, http.StatusInternalServerError, protocol.Verdict{Reason: reasonInternal, Detail: []string{"internal error"}})
		return
	}
	code, verdict := http.StatusForbidden, protocol.VerdictQuarantine
	switch {
	case f.Reason == reasonSession:
		code, verdict = http.StatusNotFound, ""
	case f.Reason == reasonNetBox:
		code, verdict = http.StatusServiceUnavailable, protocol.VerdictRefused
	case f.Reason == reasonSerial:
		code, verdict = http.StatusBadRequest, protocol.VerdictRefused
	case f.Unauthenticated:
		verdict = protocol.VerdictRefused
	case f.Unquarantined:
		verdict = protocol.VerdictFailedNoQuarantine
	case f.Reason == reasonEKPending:
		verdict = protocol.VerdictPending
	}
	writeJSON(w, code, protocol.Verdict{Verdict: verdict, Reason: f.Reason, Detail: []string{f.Detail}})
}

func (s *Server) start(w http.ResponseWriter, r *http.Request) {
	var req protocol.StartRequest
	if !decode(w, r, &req) {
		return
	}
	resp, err := s.V.Start(r.Context(), req)
	if err != nil {
		s.writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) evidence(w http.ResponseWriter, r *http.Request) {
	var req protocol.EvidenceRequest
	if !decode(w, r, &req) {
		return
	}
	verdict, err := s.V.Evidence(withClient(r.Context(), clientAddress(r)), r.PathValue("session"), req)
	if err != nil {
		s.writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, verdict)
}

func (s *Server) confirm(w http.ResponseWriter, r *http.Request) {
	var req protocol.ConfirmRequest
	if !decode(w, r, &req) {
		return
	}
	resp, err := s.V.Confirm(r.Context(), r.PathValue("session"), req)
	if err != nil {
		s.writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// localDevID builds the lookup answer from the store.
func (s *Server) localDevID(serial string) (protocol.DevID, bool, error) {
	rec, found, err := s.V.Store.RecordBySerial(serial)
	if err != nil || !found || !rec.Issued() {
		return protocol.DevID{}, false, err
	}
	return s.devIDOf(rec)
}

// liftedDevID is the DevID the service keeps for a machine it quarantined,
// once NetBox answers that the owner cleared the quarantine: the device is
// known, blocked by no status, and its attest_verdict is no quarantine. It
// gives the node its key blobs and opens a renewal or a daily check, whose
// LAK signature, LDevID certification and boot policy decide before anything
// is written; the record stays quarantined until such a check
// passes. Without NetBox no owner lifts a quarantine, so there is none.
func (s *Server) liftedDevID(ctx context.Context, serial string) (protocol.DevID, bool, error) {
	if s.V.NetBox == nil {
		return protocol.DevID{}, false, nil
	}
	rec, found, err := s.V.Store.RecordBySerial(serial)
	if err != nil || !found || rec.Status != StatusQuarantined {
		return protocol.DevID{}, false, err
	}
	m, ok, err := s.V.NetBox.Lookup(ctx, serial)
	if err != nil {
		s.Log.Warn("NetBox lookup for a lifted quarantine", "serial", serial, "err", err)
		return protocol.DevID{}, false, nil
	}
	if !ok || m.blocked() {
		return protocol.DevID{}, false, nil
	}
	return s.devIDOf(rec)
}

// devIDOf reads a record's files into a DevID answer.
func (s *Server) devIDOf(rec Record) (protocol.DevID, bool, error) {
	files := map[string][]byte{}
	for _, f := range ServedFiles {
		b, err := s.V.Store.File(rec.Machine, f)
		if err != nil {
			return protocol.DevID{}, false, fmt.Errorf("%s of %s: %w", f, rec.Machine, err)
		}
		files[f] = b
	}
	d := protocol.DevID{
		Machine:       rec.Machine,
		Serial:        rec.Serial,
		LDevIDCert:    string(files[fileLDevIDCert]),
		LAKCert:       string(files[fileLAKCert]),
		Chain:         string(files[fileChain]),
		LDevIDPublic:  files[fileLDevIDPub],
		LDevIDPrivate: files[fileLDevIDPriv],
		AKPublic:      files[fileAKPub],
		AKPrivate:     files[fileAKPriv],
		SRK:           protocol.SRKECCHighRange,
		RSAEKCert:     rec.RSAEKCert,
		AttestedAt:    rec.AttestedAt,
		Confirmed:     rec.Confirmed,
	}
	for _, alg := range []string{"rsa", "ecc"} {
		if h := rec.EKHashes[alg]; h != "" {
			d.EKHashes = append(d.EKHashes, h)
			if d.EKHashesByAlg == nil {
				d.EKHashesByAlg = map[string]string{}
			}
			d.EKHashesByAlg[alg] = h
		}
	}
	return d, true, nil
}

// localStatus is the store's verdict for a serial. A machine waiting for
// first-intake approval has none.
func (s *Server) localStatus(serial string) (protocol.Status, bool, error) {
	rec, found, err := s.V.Store.RecordBySerial(serial)
	if err != nil || !found {
		return protocol.Status{}, false, err
	}
	st := protocol.Status{Node: rec.Machine, UUID: rec.UUID, AttestedAt: rec.AttestedAt, RSAEKCert: rec.RSAEKCert, UpdatedAt: rec.UpdatedAt, Class: rec.Class, LDevIDSerial: rec.LDevIDSerial}
	if s.V.CA != nil {
		st.Site = s.V.CA.Site
	}
	switch rec.Status {
	case StatusAttested:
		st.Status = protocol.StatusAttested
	case StatusQuarantined:
		st.Status = protocol.StatusQuarantined
	default:
		return protocol.Status{}, false, nil
	}
	return st, true, nil
}

// status is the verdict for a serial: NetBox's, when the service has one
// and it answers, else the service's own. NetBox holds no UUID and no EK
// certificate flag, so the record of the same attestation fills those in.
func (s *Server) status(ctx context.Context, serial string) (protocol.Status, bool, error) {
	st, ok, err := s.localStatus(serial)
	if err != nil {
		return st, ok, err
	}
	if s.V.NetBox == nil {
		return st, ok, nil
	}
	nb, found, nerr := s.V.NetBox.Verdict(ctx, serial)
	if nerr != nil {
		s.Log.Warn("NetBox verdict", "serial", serial, "err", nerr)
		return st, ok, nil
	}
	if !found {
		// NetBox has the last word: a pass it does not hold has not been
		// recorded; a pending, retired or unknown machine is unknown.
		return protocol.Status{}, false, nil
	}
	// A quarantine whose NetBox write failed still withdraws: the stale
	// pass does not reopen it.
	if ok && st.Status == protocol.StatusQuarantined && nb.Status == protocol.StatusAttested && !st.UpdatedAt.Before(nb.AttestedAt.Truncate(time.Second)) {
		s.Log.Warn("NetBox holds a pass the service has withdrawn", "serial", serial, "updated", st.UpdatedAt, "netbox_attested", nb.AttestedAt)
		return st, true, nil
	}
	if ok && sameAttestation(st, nb) {
		nb.UUID, nb.RSAEKCert = st.UUID, st.RSAEKCert
	}
	return nb, true, nil
}

// sameAttestation is whether the service's record and NetBox's verdict stand
// on the same LDevID: by its serial when both name one, since a daily check
// moves attested_at without issuing, else by attested_at to the second, as
// NetBox keeps it.
func sameAttestation(mine, nb protocol.Status) bool {
	if mine.LDevIDSerial != "" && nb.LDevIDSerial != "" {
		return strings.EqualFold(mine.LDevIDSerial, nb.LDevIDSerial)
	}
	return mine.AttestedAt.Truncate(time.Second).Equal(nb.AttestedAt.Truncate(time.Second))
}

// lookup returns the LDevID of the newest verdict, only when that verdict
// is a pass. A quarantine revokes the identity: its lookup is a refusal,
// which the handlers answer 403.
func (s *Server) lookup(ctx context.Context, serial string) (protocol.DevID, bool, error) {
	gate, ok, err := s.status(ctx, serial)
	if err == nil && ok && gate.Status == protocol.StatusQuarantined {
		f := &Failure{Reason: reasonStatus, Detail: fmt.Sprintf("%s is quarantined; no LDevID is served for it until the owner clears its verdict", gate.Node), Unauthenticated: true}
		return protocol.DevID{}, false, f
	}
	if err != nil || !ok || gate.Status != protocol.StatusAttested {
		return protocol.DevID{}, false, err
	}
	d, ok, err := s.localDevID(serial)
	if err != nil || !ok {
		return protocol.DevID{}, false, err
	}
	if s.V.NetBox != nil {
		mine, _, err := s.localStatus(serial)
		if err != nil {
			return protocol.DevID{}, false, err
		}
		if !sameAttestation(mine, gate) {
			// NetBox records a pass the service does not hold: serve
			// nothing rather than an older certificate.
			return protocol.DevID{}, false, nil
		}
	}
	return d, true, nil
}

func (s *Server) verdict(w http.ResponseWriter, r *http.Request) {
	st, ok, err := s.status(r.Context(), r.PathValue("serial"))
	if err != nil {
		s.writeError(w, err)
		return
	}
	if !ok {
		writeJSON(w, http.StatusNotFound, protocol.Status{Status: "unknown"})
		return
	}
	writeJSON(w, http.StatusOK, st)
}

// devID answers the DevID of the newest pass. Once the owner lifts a
// quarantine, it also answers the quarantined node's DevID, whose TPM-bound
// blobs the node needs to prove itself in the next check; the raw files that
// SPIRE's agent reads (devIDFile) come back only when that check passes.
func (s *Server) devID(w http.ResponseWriter, r *http.Request) {
	d, ok, err := s.lookup(r.Context(), r.PathValue("serial"))
	if err == nil && !ok {
		d, ok, err = s.liftedDevID(r.Context(), r.PathValue("serial"))
	}
	if err != nil {
		s.writeError(w, err)
		return
	}
	if !ok {
		http.NotFound(w, r)
		return
	}
	writeJSON(w, http.StatusOK, d)
}

// devIDFile serves one file raw, for an init container that writes the
// files SPIRE's tpm_devid agent reads.
func (s *Server) devIDFile(w http.ResponseWriter, r *http.Request) {
	file := r.PathValue("file")
	if !slices.Contains(ServedFiles, file) {
		http.NotFound(w, r)
		return
	}
	d, ok, err := s.lookup(r.Context(), r.PathValue("serial"))
	if err != nil {
		s.writeError(w, err)
		return
	}
	if !ok {
		http.NotFound(w, r)
		return
	}
	body := map[string][]byte{
		fileLDevIDCert: []byte(d.LDevIDCert),
		fileLAKCert:    []byte(d.LAKCert),
		fileChain:      []byte(d.Chain),
		fileLDevIDPub:  d.LDevIDPublic,
		fileLDevIDPriv: d.LDevIDPrivate,
		fileAKPub:      d.AKPublic,
		fileAKPriv:     d.AKPrivate,
	}[file]
	ctype := "application/octet-stream"
	if strings.HasSuffix(file, ".crt") || strings.HasSuffix(file, ".pem") {
		ctype = "application/x-pem-file"
	}
	w.Header().Set("Content-Type", ctype)
	_, _ = w.Write(body)
}

func (s *Server) machines(w http.ResponseWriter, _ *http.Request) {
	recs, err := s.V.Store.Records()
	if err != nil {
		s.writeError(w, err)
		return
	}
	pending, err := s.V.Store.Pendings()
	if err != nil {
		s.writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"machines": recs, "pending": pending})
}

// renewStart opens a renewal for a running node. The LAK and the AK blobs
// come from the newest pass.
func (s *Server) renewStart(w http.ResponseWriter, r *http.Request) {
	var req protocol.RenewRequest
	if !decode(w, r, &req) {
		return
	}
	// A blocked machine is 403 before any lookup, whatever is on file.
	if err := s.V.RenewAllowed(r.Context(), req.Serial); err != nil {
		s.writeError(w, err)
		return
	}
	d, ok, err := s.lookup(r.Context(), req.Serial)
	if err == nil && !ok {
		// A quarantine the owner lifted in NetBox: the DevID on file opens a
		// session that proves everything again.
		d, ok, err = s.liftedDevID(r.Context(), req.Serial)
	}
	if err != nil {
		s.writeError(w, err)
		return
	}
	if !ok {
		writeJSON(w, http.StatusNotFound, protocol.Verdict{Reason: reasonUnknownMachine, Detail: []string{"no LDevID on file for serial " + req.Serial + "; attest from HookOS first"}})
		return
	}
	resp, err := s.V.RenewStart(r.Context(), req.Serial, d, req.Check)
	if err != nil {
		s.writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) renewEvidence(w http.ResponseWriter, r *http.Request) {
	var req protocol.RenewEvidence
	if !decode(w, r, &req) {
		return
	}
	renewed, err := s.V.RenewEvidence(r.Context(), r.PathValue("session"), req)
	if err != nil {
		s.writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, renewed)
}
