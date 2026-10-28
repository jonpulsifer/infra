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

func (s *Server) devIDRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET "+protocol.PathDevID, s.devID)
	mux.HandleFunc("GET "+protocol.PathVerdict, s.verdict)
	mux.HandleFunc("GET "+protocol.PathDevID+"/{file}", s.devIDFile)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok\n")) })
}

func (s *Server) Admin() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /machines", s.machines)
	mux.HandleFunc("POST /approve", s.approve)
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
	switch f.Reason {
	case reasonSession:
		code, verdict = http.StatusNotFound, ""
	case reasonEKPending:
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
	if err := s.V.Confirm(r.Context(), r.PathValue("session"), req); err != nil {
		s.writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "confirmed"})
}

// localDevID builds the lookup answer from this anchor's store.
func (s *Server) localDevID(serial string) (protocol.DevID, bool, error) {
	m, ok := s.V.Inventory.BySerial(serial)
	if !ok {
		return protocol.DevID{}, false, nil
	}
	rec, found, err := s.V.Store.Record(m.Name)
	if err != nil || !found || !rec.Issued() {
		return protocol.DevID{}, false, err
	}
	files := map[string][]byte{}
	for _, f := range ServedFiles {
		b, err := s.V.Store.File(m.Name, f)
		if err != nil {
			return protocol.DevID{}, false, fmt.Errorf("%s of %s: %w", f, m.Name, err)
		}
		files[f] = b
	}
	d := protocol.DevID{
		Machine:       m.Name,
		Serial:        m.Serial,
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
		}
	}
	return d, true, nil
}

// localStatus is this anchor's verdict for a serial. A machine waiting for
// first-intake approval has none.
func (s *Server) localStatus(serial string) (protocol.Status, bool, error) {
	m, ok := s.V.Inventory.BySerial(serial)
	if !ok {
		return protocol.Status{}, false, nil
	}
	rec, found, err := s.V.Store.Record(m.Name)
	if err != nil || !found {
		return protocol.Status{}, false, err
	}
	st := protocol.Status{Node: rec.Machine, UUID: rec.UUID, AttestedAt: rec.AttestedAt, RSAEKCert: rec.RSAEKCert, UpdatedAt: rec.UpdatedAt}
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

// status is the newest verdict for a serial across this anchor and its
// peers: each anchor keeps the attestations it ran, at the boot VIP's
// holder of the day.
func (s *Server) status(ctx context.Context, serial string, local bool) (protocol.Status, bool, error) {
	st, ok, err := s.localStatus(serial)
	if err != nil || local {
		return st, ok, err
	}
	for _, peer := range s.Peers {
		var ps protocol.Status
		found, err := s.fetchPeer(ctx, peer, "/verdict/", serial, &ps)
		if err != nil {
			s.Log.Debug("peer verdict", "peer", peer, "serial", serial, "err", err)
			continue
		}
		if found && (!ok || ps.UpdatedAt.After(st.UpdatedAt)) {
			st, ok = ps, true
		}
	}
	return st, ok, nil
}

// lookup returns the LDevID of the newest verdict, only when that verdict
// is a pass: a later quarantine on any anchor withdraws it.
func (s *Server) lookup(ctx context.Context, serial string, local bool) (protocol.DevID, bool, error) {
	st, ok, err := s.status(ctx, serial, local)
	if err != nil || !ok || st.Status != protocol.StatusAttested {
		return protocol.DevID{}, false, err
	}
	d, ok, err := s.localDevID(serial)
	if err != nil {
		return d, false, err
	}
	if ok && d.AttestedAt.Equal(st.AttestedAt) {
		return d, true, nil
	}
	if local {
		return protocol.DevID{}, false, nil
	}
	for _, peer := range s.Peers {
		var pd protocol.DevID
		found, err := s.fetchPeer(ctx, peer, "/devid/", serial, &pd)
		if err != nil {
			s.Log.Debug("peer lookup", "peer", peer, "serial", serial, "err", err)
			continue
		}
		if found && serialKey(pd.Serial) == serialKey(serial) && pd.AttestedAt.Equal(st.AttestedAt) {
			return pd, true, nil
		}
	}
	return protocol.DevID{}, false, nil
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
	writeJSON(w, http.StatusOK, map[string]any{"machines": recs, "inventory": s.V.Inventory.Names()})
}

func (s *Server) approve(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Serial string `json:"serial"`
	}
	if !decode(w, r, &req) {
		return
	}
	hashes, err := s.V.Approve(req.Serial)
	if err != nil {
		s.writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"approved": hashes,
		"next":     "add these to the machine's ek_hash and ek_hash_ecc in clusters/folly/inventory/machines.yaml",
	})
}
