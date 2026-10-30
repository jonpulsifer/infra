package main

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

	"github.com/jonpulsifer/infra/apps/talos-attest/protocol"
)

// Server holds the three listeners' handlers: the device flow on the
// bootstrap VLAN, the DevID lookup for cluster nodes, and the owner's admin
// API on the tailnet.
type Server struct {
	V         *Verifier
	Log       *slog.Logger
	Approvers map[string]bool
	// Peers are the other anchors' DevID listeners, asked when this anchor
	// holds no record for a serial.
	Peers  []string
	Client *http.Client
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
	mux.HandleFunc("POST /approve", s.approve)
	mux.HandleFunc("GET /intake", s.intake)
	mux.HandleFunc("POST /intake", s.setIntake)
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
	case f.Reason == reasonIntakeRate:
		code, verdict = http.StatusTooManyRequests, protocol.VerdictRefused
	case f.Reason == reasonApproval:
		code, verdict = http.StatusBadRequest, ""
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
	verdict, err := s.V.Evidence(r.Context(), r.PathValue("session"), req)
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

// localDevID builds the lookup answer from this anchor's store.
func (s *Server) localDevID(serial string) (protocol.DevID, bool, error) {
	rec, found, err := s.V.Store.RecordBySerial(serial)
	if err != nil || !found || !rec.Issued() {
		return protocol.DevID{}, false, err
	}
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

// localStatus is this anchor's verdict for a serial. A machine waiting for
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
// and it answers, else this anchor's own. A peer never gates: its answers
// arrive over plain HTTP, so only a pass whose certificates verify is ever
// taken from one, and only by adopting it into this anchor's own records
// (see refresh). NetBox holds no UUID and no EK certificate flag, so this
// anchor's record of the same attestation fills those in.
func (s *Server) status(ctx context.Context, serial string, local bool) (protocol.Status, bool, error) {
	if !local {
		// A pass this anchor lacks may be on a peer: adopt it first, so the
		// local record is the fleet's newest pass.
		s.refresh(ctx, serial)
	}
	st, ok, err := s.localStatus(serial)
	if err != nil {
		return st, ok, err
	}
	if s.V.NetBox == nil || local {
		if ok && s.retiredInNetBox(ctx, serial) {
			return protocol.Status{}, false, nil
		}
		return st, ok, nil
	}
	nb, found, nerr := s.V.NetBox.Verdict(ctx, serial)
	if nerr != nil {
		s.Log.Warn("NetBox verdict", "serial", serial, "err", nerr)
		return st, ok, nil
	}
	if !found {
		// NetBox has the last word: an anchor's pass it does not hold has
		// not been recorded; a pending, retired or unknown machine is unknown.
		return protocol.Status{}, false, nil
	}
	// A quarantine this anchor produced that NetBox missed, because the
	// write failed, still withdraws: the stale pass does not reopen it.
	// Only this anchor's own record counts here; adopt never writes one.
	if ok && st.Status == protocol.StatusQuarantined && nb.Status == protocol.StatusAttested && !st.UpdatedAt.Before(nb.AttestedAt.Truncate(time.Second)) {
		s.Log.Warn("NetBox holds a pass this anchor has withdrawn", "serial", serial, "anchor_updated", st.UpdatedAt, "netbox_attested", nb.AttestedAt)
		return st, true, nil
	}
	if ok && sameAttestation(st, nb) {
		nb.UUID, nb.RSAEKCert = st.UUID, st.RSAEKCert
	}
	return nb, true, nil
}

// sameAttestation is whether an anchor's record and NetBox's verdict stand
// on the same LDevID: by its serial when both name one, since a daily check
// moves attested_at without issuing, else by attested_at to the second, as
// NetBox keeps it.
func sameAttestation(mine, nb protocol.Status) bool {
	if mine.LDevIDSerial != "" && nb.LDevIDSerial != "" {
		return strings.EqualFold(mine.LDevIDSerial, nb.LDevIDSerial)
	}
	return mine.AttestedAt.Truncate(time.Second).Equal(nb.AttestedAt.Truncate(time.Second))
}

// retiredInNetBox is whether NetBox, when configured, has the device as
// decommissioning or offline, in which case nothing is served for it.
func (s *Server) retiredInNetBox(ctx context.Context, serial string) bool {
	if s.V.NetBox == nil {
		return false
	}
	m, ok, err := s.V.NetBox.Lookup(ctx, serial)
	return err == nil && ok && (m.Status == statusDecommissioning || m.Status == statusOffline)
}

// lookup returns the LDevID of the newest verdict, only when that verdict
// is a pass. The files live on the anchor that issued them; refresh has
// brought a peer's newer pass here already.
func (s *Server) lookup(ctx context.Context, serial string, local bool) (protocol.DevID, bool, error) {
	gate, ok, err := s.status(ctx, serial, local)
	if err != nil || !ok || gate.Status != protocol.StatusAttested {
		return protocol.DevID{}, false, err
	}
	d, ok, err := s.localDevID(serial)
	if err != nil || !ok {
		return protocol.DevID{}, false, err
	}
	if s.V.NetBox != nil && !local {
		mine, _, err := s.localStatus(serial)
		if err != nil {
			return protocol.DevID{}, false, err
		}
		if !sameAttestation(mine, gate) {
			// NetBox records a pass no anchor could hand us: serve nothing
			// rather than an older certificate.
			return protocol.DevID{}, false, nil
		}
	}
	return d, true, nil
}

// peerSlack is how far ahead of this anchor's clock a peer's timestamps may
// be before its answer is refused.
const peerSlack = 5 * time.Minute

// refresh adopts the newest pass a peer holds for serial when it is newer
// than anything this anchor holds. Newer means the LDevID's issue time, the
// NotBefore this CA signed, not the peer's timestamps, which a host posing
// as a peer sets as it likes; its timestamps may still not run ahead of
// this clock by more than peerSlack. A peer's quarantine is never adopted;
// NetBox carries those, written synchronously by the anchor that produced
// them.
func (s *Server) refresh(ctx context.Context, serial string) {
	if len(s.Peers) == 0 || s.V.CA == nil {
		return
	}
	newest, haveLocal, _ := s.V.Store.NewestIssueFor(serial)
	local, _, _ := s.V.Store.RecordBySerial(serial)
	now := s.V.Now()
	var best protocol.DevID
	var bestStatus protocol.Status
	var bestIssued time.Time
	found := false
	for _, peer := range s.Peers {
		var ps protocol.Status
		ok, err := s.fetchPeer(ctx, peer, "/verdict/", serial, &ps)
		if err != nil {
			s.Log.Debug("peer verdict", "peer", peer, "serial", serial, "err", err)
			continue
		}
		if !ok || ps.Status != protocol.StatusAttested {
			continue
		}
		if ps.UpdatedAt.After(now.Add(peerSlack)) || ps.AttestedAt.After(now.Add(peerSlack)) {
			s.Log.Warn("peer answer from the future refused", "peer", peer, "serial", serial, "updated_at", ps.UpdatedAt, "attested_at", ps.AttestedAt)
			continue
		}
		var pd protocol.DevID
		ok, err = s.fetchPeer(ctx, peer, "/devid/", serial, &pd)
		if err != nil || !ok || serialKey(pd.Serial) != serialKey(serial) {
			continue
		}
		checked, err := s.V.VerifyDevID(pd, pd.Machine, pd.Serial)
		if err != nil {
			s.Log.Warn("peer answer refused", "peer", peer, "serial", serial, "err", err)
			continue
		}
		// The verdict must be the pass the DevID carries: by the LDevID's
		// serial when the peer names it, else by the attestation time.
		if ps.LDevIDSerial != "" && !strings.EqualFold(ps.LDevIDSerial, serialHex(checked.LDevID)) || ps.LDevIDSerial == "" && !pd.AttestedAt.Equal(ps.AttestedAt) {
			continue
		}
		issued := checked.LDevID.NotBefore
		if issued.After(now.Add(peerSlack)) {
			s.Log.Warn("peer answer from the future refused", "peer", peer, "serial", serial, "issued", issued)
			continue
		}
		if haveLocal && !issued.After(newest) {
			continue
		}
		if local.Status == StatusQuarantined && !issued.After(local.UpdatedAt) {
			// A pass issued before this anchor's quarantine is a replay of
			// the machine's own history, not news.
			s.Log.Warn("peer replays a pass from before this anchor's quarantine", "peer", peer, "serial", serial, "issued", issued, "quarantined_at", local.UpdatedAt)
			continue
		}
		if found && !issued.After(bestIssued) {
			continue
		}
		best, bestStatus, bestIssued, found = pd, ps, issued, true
	}
	if !found {
		return
	}
	if err := s.adopt(best, bestStatus); err != nil {
		s.Log.Warn("adopt a peer's attestation", "serial", serial, "err", err)
	}
}

// adopt saves a peer's attestation as this anchor's record of the machine,
// with the files it serves, when its LDevID was issued later than every
// record this anchor holds for the serial, and later than this anchor's
// own quarantine of it. The record is stamped with this anchor's clock.
func (s *Server) adopt(d protocol.DevID, st protocol.Status) error {
	if s.V.CA == nil {
		return errors.New("no CA to verify a peer's answer against")
	}
	// A peer answers over plain HTTP: its certificates must be this CA's
	// and its blobs the keys they certify, or nothing is kept.
	checked, err := s.V.VerifyDevID(d, d.Machine, d.Serial)
	if err != nil {
		return err
	}
	ldevid, lak := checked.LDevID, checked.LAK
	now := s.V.Now()
	issued := ldevid.NotBefore
	if st.UpdatedAt.After(now.Add(peerSlack)) || d.AttestedAt.After(now.Add(peerSlack)) || issued.After(now.Add(peerSlack)) {
		return fmt.Errorf("the peer's timestamps are ahead of this anchor's clock")
	}
	if prev, ok, _ := s.V.Store.RecordBySerial(d.Serial); ok && prev.Status == StatusQuarantined && !issued.After(prev.UpdatedAt) {
		return fmt.Errorf("the LDevID was issued at %s, before this anchor quarantined %s at %s: a replay", issued.Format(time.RFC3339), prev.Machine, prev.UpdatedAt.Format(time.RFC3339))
	}
	newest, haveLocal, err := s.V.Store.NewestIssueFor(d.Serial)
	if err != nil {
		return err
	}
	if haveLocal && !issued.After(newest) {
		return nil
	}
	attestedAt := d.AttestedAt
	if attestedAt.After(now) {
		attestedAt = now
	}
	rec := Record{
		Machine: d.Machine, Serial: d.Serial, UUID: st.UUID, Status: StatusAttested, Class: strings.Join(ldevid.Subject.OrganizationalUnit, ","),
		RSAEKCert: d.RSAEKCert, LDevIDSerial: serialHex(ldevid), LDevIDNotAfter: ldevid.NotAfter, LDevIDNotBefore: issued, LAKSerial: serialHex(lak),
		AttestedAt: attestedAt, Confirmed: d.Confirmed, UpdatedAt: now,
		// Hashes a peer reports were proven there, not here: never pins from this record.
		EKHashes: hashesByAlg(d),
	}
	if prev, ok, _ := s.V.Store.RecordBySerial(d.Serial); ok {
		rec.UUID, rec.MAC, rec.Model, rec.SKU, rec.BIOS, rec.NVIndexes = firstOf(rec.UUID, prev.UUID), prev.MAC, prev.Model, prev.SKU, prev.BIOS, prev.NVIndexes
		rec.Renewed = prev.Issued() && prev.LDevIDSerial != rec.LDevIDSerial
	}
	files := map[string][]byte{
		fileLDevIDCert: []byte(d.LDevIDCert), fileLAKCert: []byte(d.LAKCert), fileChain: []byte(d.Chain),
		fileLDevIDPub: d.LDevIDPublic, fileLDevIDPriv: d.LDevIDPrivate, fileAKPub: d.AKPublic, fileAKPriv: d.AKPrivate,
	}
	if err := s.V.Store.Save(rec, files); err != nil {
		return err
	}
	// Issued later than every record of the serial here, so the older ones go.
	if err := s.V.Store.RetireOthers(rec.Serial, rec.Machine); err != nil {
		s.Log.Warn("retire old records", "machine", rec.Machine, "err", err)
	}
	s.Log.Info("adopted a peer's attestation", "machine", rec.Machine, "ldevid_serial", rec.LDevIDSerial, "issued", issued)
	s.V.changed()
	return nil
}

func firstOf(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// SyncPeers brings this anchor's records up to the newest pass across the
// anchors, such as a renewal served elsewhere. It runs on a timer, so the
// expiry each anchor exports is the fleet's, not its own. Quarantines are
// not taken from peers: NetBox carries them.
func (s *Server) SyncPeers(ctx context.Context) {
	recs, err := s.V.Store.Records()
	if err != nil {
		s.Log.Warn("peer sync", "err", err)
		return
	}
	for _, local := range recs {
		s.refresh(ctx, local.Serial)
	}
}

// RunPeerSync backfills NetBox at once, then backfills and calls SyncPeers
// every interval until ctx ends.
func (s *Server) RunPeerSync(ctx context.Context, interval time.Duration) {
	s.V.BackfillNetBox(ctx)
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.V.BackfillNetBox(ctx)
			s.SyncPeers(ctx)
		}
	}
}

// fetchPeer asks a peer for its own answer only, so peers never recurse.
func (s *Server) fetchPeer(ctx context.Context, peer, route, serial string, out any) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSuffix(peer, "/")+route+url.PathEscape(serial)+"?local=1", nil)
	if err != nil {
		return false, err
	}
	resp, err := s.Client.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return false, nil
	}
	if resp.StatusCode != http.StatusOK {
		return false, fmt.Errorf("%s", resp.Status)
	}
	return true, json.NewDecoder(io.LimitReader(resp.Body, maxBody)).Decode(out)
}

func (s *Server) verdict(w http.ResponseWriter, r *http.Request) {
	st, ok, err := s.status(r.Context(), r.PathValue("serial"), r.URL.Query().Has("local"))
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

func (s *Server) devID(w http.ResponseWriter, r *http.Request) {
	d, ok, err := s.lookup(r.Context(), r.PathValue("serial"), r.URL.Query().Has("local"))
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
	d, ok, err := s.lookup(r.Context(), r.PathValue("serial"), r.URL.Query().Has("local"))
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
	var inventory []string
	if s.V.Inventory != nil {
		inventory = s.V.Inventory.Names()
	}
	writeJSON(w, http.StatusOK, map[string]any{"machines": recs, "pending": pending, "inventory": inventory})
}

func (s *Server) approve(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Serial   string   `json:"serial"`
		EKHashes []string `json:"ek_hashes"`
	}
	if !decode(w, r, &req) {
		return
	}
	hashes, err := s.V.Approve(r.Context(), req.Serial, req.EKHashes, strings.ToLower(r.Header.Get("Tailscale-User-Login")))
	if err != nil {
		s.writeError(w, err)
		return
	}
	next := "the next attest writes these to the device's ek_hash and ek_hash_ecc in NetBox"
	if s.V.NetBox == nil {
		next = "add these to the machine's ek_hash and ek_hash_ecc in clusters/folly/inventory/machines.yaml"
	}
	writeJSON(w, http.StatusOK, map[string]any{"approved": hashes, "next": next})
}

// renewStart opens a renewal for a running node. The LAK and the AK blobs
// come from the newest pass, on this anchor or a peer.
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
	d, ok, err := s.lookup(r.Context(), req.Serial, false)
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
