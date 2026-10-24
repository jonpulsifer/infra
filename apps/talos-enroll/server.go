package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"log/slog"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
	"unicode"
)

const grantDeviceCode = "urn:ietf:params:oauth:grant-type:device_code"

//go:embed index.html
var indexHTML string

var indexTmpl = template.Must(template.New("index").Funcs(template.FuncMap{
	"until": func(t time.Time) string { return time.Until(t).Round(time.Second).String() },
}).Parse(indexHTML))

// Server holds both listeners' handlers. The public one faces Talos through
// the Gateway; the admin one faces the owner through the tailnet Ingress.
type Server struct {
	Store     *Store
	Render    Renderer
	Out       *Outbox
	Log       *slog.Logger
	ClientID  string
	Approvers map[string]bool
	AdminURL  string
	MACs      map[string]string
	Now       func() time.Time
}

func (s *Server) Public() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /device/code", s.deviceCode)
	mux.HandleFunc("POST /token", s.token)
	mux.HandleFunc("GET /config", s.config)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok\n")) })
	mux.HandleFunc("GET /metrics", s.metrics)
	return mux
}

func (s *Server) Admin() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", s.index)
	mux.HandleFunc("GET /pending", s.pending)
	mux.HandleFunc("POST /approve/{code}", s.approve)
	mux.HandleFunc("POST /deny/{code}", s.deny)
	return s.requireApprover(mux)
}

type loginKey struct{}

// requireApprover trusts Tailscale-User-Login because the NetworkPolicy admits
// only the tailnet Ingress proxy, which overwrites any copy a client sends.
func (s *Server) requireApprover(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		login := r.Header.Get("Tailscale-User-Login")
		if login == "" || !s.Approvers[strings.ToLower(login)] {
			s.Log.Warn("admin request refused", "login", login, "path", r.URL.Path)
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if r.Method == http.MethodPost && !sameOrigin(r) {
			s.Log.Warn("cross-origin admin request refused", "login", login, "origin", r.Header.Get("Origin"))
			http.Error(w, "cross-origin request refused", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), loginKey{}, login)))
	})
}

// sameOrigin admits a browser form from this page and a client that sends no
// fetch metadata, such as curl. An older browser falls back to Origin.
func sameOrigin(r *http.Request) bool {
	switch r.Header.Get("Sec-Fetch-Site") {
	case "same-origin", "none":
		return true
	case "":
	default:
		return false
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	return err == nil && (u.Host == r.Host || u.Host == r.Header.Get("X-Forwarded-Host"))
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeOAuthError(w http.ResponseWriter, e *OAuthError) {
	writeJSON(w, e.Status, e)
}

// cleanField refuses a value that cannot be a device fact, including a Talos
// placeholder that was never filled.
func cleanField(v string) (string, bool) {
	v = strings.TrimSpace(v)
	if len(v) > 128 || strings.Contains(v, "${") {
		return "", false
	}
	for _, r := range v {
		if !unicode.IsPrint(r) {
			return "", false
		}
	}
	return v, true
}

func client(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return strings.TrimSpace(strings.Split(xff, ",")[0])
	}
	return r.RemoteAddr
}

func (s *Server) parseForm(w http.ResponseWriter, r *http.Request) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	if err := r.ParseForm(); err != nil {
		writeOAuthError(w, oauthErr(400, "invalid_request", "the body is not a form"))
		return false
	}
	return true
}

func (s *Server) deviceCode(w http.ResponseWriter, r *http.Request) {
	if !s.parseForm(w, r) {
		return
	}
	if r.PostForm.Get("client_id") != s.ClientID {
		writeOAuthError(w, oauthErr(401, "invalid_client", "unknown client_id"))
		return
	}
	var d Device
	var ok [4]bool
	d.UUID, ok[0] = cleanField(r.PostForm.Get("uuid"))
	d.MAC, ok[1] = cleanField(r.PostForm.Get("mac"))
	d.Serial, ok[2] = cleanField(r.PostForm.Get("serial"))
	d.Hostname, ok[3] = cleanField(r.PostForm.Get("hostname"))
	if ok != [4]bool{true, true, true, true} || d.UUID == "" {
		s.Log.Warn("device request refused", "reason", "bad device fields", "client", client(r))
		writeOAuthError(w, oauthErr(400, "invalid_request", "uuid is required, and no field may hold a placeholder"))
		return
	}

	e, deviceCode, oerr := s.Store.Start(d)
	if oerr != nil {
		s.Log.Warn("device request refused", "reason", oerr.Code, "uuid", d.UUID, "mac", d.MAC, "client", client(r))
		writeOAuthError(w, oerr)
		return
	}
	suggested := s.suggest(d.MAC)
	s.Log.Info("device code issued", "user_code", e.UserCode, "uuid", d.UUID, "mac", d.MAC,
		"serial", d.Serial, "hostname", d.Hostname, "suggested_node", suggested, "client", client(r))
	s.Out.Send(normUUID(d.UUID), s.pendingMessage(e, suggested))

	writeJSON(w, http.StatusOK, map[string]any{
		"device_code":               deviceCode,
		"user_code":                 e.UserCode,
		"verification_uri":          s.AdminURL + "/",
		"verification_uri_complete": s.AdminURL + "/?code=" + e.UserCode,
		"expires_in":                int(e.Expires.Sub(s.Now()).Round(time.Second).Seconds()),
		"interval":                  int(s.Store.interval.Seconds()),
	})
}

func (s *Server) token(w http.ResponseWriter, r *http.Request) {
	// Talos sends each poll twice, with and without Basic auth. Both carry
	// client_id in the body, which is all this server checks.
	if !s.parseForm(w, r) {
		return
	}
	if r.PostForm.Get("client_id") != s.ClientID {
		writeOAuthError(w, oauthErr(401, "invalid_client", "unknown client_id"))
		return
	}
	if r.PostForm.Get("grant_type") != grantDeviceCode {
		writeOAuthError(w, oauthErr(400, "unsupported_grant_type", ""))
		return
	}
	token, ttl, oerr := s.Store.Poll(r.PostForm.Get("device_code"), r.PostForm.Get("uuid"))
	if oerr != nil {
		if oerr.Code != "authorization_pending" {
			s.Log.Info("token poll refused", "reason", oerr.Code, "uuid", r.PostForm.Get("uuid"), "client", client(r))
		}
		writeOAuthError(w, oerr)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"access_token": token,
		"token_type":   "Bearer",
		"expires_in":   int(ttl.Seconds()),
	})
}

func hasPlaceholder(q url.Values) bool {
	for _, vs := range q {
		for _, v := range vs {
			if strings.Contains(v, "${") {
				return true
			}
		}
	}
	return false
}

func (s *Server) config(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	uuid := q.Get("uuid")
	if hasPlaceholder(q) || strings.Contains(r.URL.RawQuery, "${") || uuid == "" {
		s.Store.refuse("placeholder")
		s.Log.Warn("config refused", "reason", "unfilled placeholder or no uuid", "query", r.URL.RawQuery, "client", client(r))
		http.Error(w, "the query must carry a filled uuid", http.StatusBadRequest)
		return
	}
	auth := r.Header.Get("Authorization")
	scheme, token, found := strings.Cut(auth, " ")
	if !found || !strings.EqualFold(scheme, "Bearer") || token == "" {
		s.Store.refuse("no_token")
		w.Header().Set("WWW-Authenticate", `Bearer realm="talos-enroll"`)
		http.Error(w, "a bearer token is required", http.StatusUnauthorized)
		return
	}
	cfg, e, err := s.Store.Config(token, uuid)
	switch {
	case errors.Is(err, ErrWrongUUID):
		s.Log.Warn("config refused", "reason", "uuid differs from the token's", "uuid", uuid, "bound_uuid", e.Device.UUID, "client", client(r))
		http.Error(w, err.Error(), http.StatusForbidden)
		return
	case err != nil:
		s.Log.Warn("config refused", "reason", "bad token", "uuid", uuid, "client", client(r))
		w.Header().Set("WWW-Authenticate", `Bearer realm="talos-enroll", error="invalid_token"`)
		http.Error(w, err.Error(), http.StatusUnauthorized)
		return
	}

	w.Header().Set("Content-Type", "application/yaml")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Length", fmt.Sprint(len(cfg)))
	w.WriteHeader(http.StatusOK)
	n, werr := w.Write(cfg)
	if werr != nil || n != len(cfg) {
		s.Log.Warn("config write failed, the token stays valid", "node", e.Node, "uuid", uuid, "err", werr)
		return
	}
	s.Store.Consume(token)
	s.Log.Info("config served", "node", e.Node, "uuid", uuid, "bytes", n, "client", client(r))
	s.Out.Send(normUUID(e.Device.UUID), fmt.Sprintf("**Talos enrollment** `%s`: **%s** fetched its config <t:%d:R>. Talos installs and reboots next.",
		e.UserCode, e.Node, s.Now().Unix()))
}

func (s *Server) suggest(mac string) string {
	mac = strings.ToLower(mac)
	if mac == "" {
		return ""
	}
	nodes := make([]string, 0, len(s.MACs))
	for node := range s.MACs {
		nodes = append(nodes, node)
	}
	sort.Strings(nodes)
	for _, node := range nodes {
		if s.MACs[node] == mac {
			return node
		}
	}
	return ""
}

// discordSafe keeps a self-asserted value inside its inline code span.
func discordSafe(v string) string {
	if v == "" {
		return "-"
	}
	return strings.NewReplacer("`", "'", "\n", " ").Replace(v)
}

func (s *Server) pendingMessage(e Enrollment, suggested string) string {
	d := e.Device
	var b strings.Builder
	fmt.Fprintf(&b, "**Talos enrollment** `%s` is waiting for approval.\n", e.UserCode)
	fmt.Fprintf(&b, "uuid `%s` · mac `%s` · serial `%s` · hostname `%s`\n",
		discordSafe(d.UUID), discordSafe(d.MAC), discordSafe(d.Serial), discordSafe(d.Hostname))
	node := suggested
	if suggested != "" {
		fmt.Fprintf(&b, "The MAC is **%s**'s in the UniFi client list.\n", suggested)
	} else {
		node = "<node>"
		b.WriteString("The MAC matches no node in the UniFi client list.\n")
	}
	fmt.Fprintf(&b, "Approve: `mise run enroll:approve %s %s` or %s/?code=%s\n", e.UserCode, node, s.AdminURL, e.UserCode)
	fmt.Fprintf(&b, "Deny: `mise run enroll:deny %s`\n", e.UserCode)
	fmt.Fprintf(&b, "The code expires <t:%d:R>.", e.Expires.Unix())
	return b.String()
}

func login(r *http.Request) string {
	v, _ := r.Context().Value(loginKey{}).(string)
	return v
}

// reply redirects a browser form back to the page and answers anything else
// with JSON.
func reply(w http.ResponseWriter, r *http.Request, status int, v map[string]any) {
	if strings.Contains(r.Header.Get("Accept"), "text/html") {
		if status/100 == 2 {
			http.Redirect(w, r, "/", http.StatusSeeOther)
			return
		}
		http.Error(w, fmt.Sprint(v["error"]), status)
		return
	}
	writeJSON(w, status, v)
}

func (s *Server) approve(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	code, node, who := r.PathValue("code"), r.FormValue("node"), login(r)

	e, err := s.Store.Lookup(code)
	switch {
	case errors.Is(err, ErrUnknownCode):
		reply(w, r, http.StatusNotFound, map[string]any{"error": err.Error()})
		return
	case err != nil:
		reply(w, r, http.StatusConflict, map[string]any{"error": err.Error(), "phase": e.Phase})
		return
	}
	if node == "" {
		reply(w, r, http.StatusBadRequest, map[string]any{"error": "name the node to enroll as", "nodes": s.Render.Nodes()})
		return
	}
	cfg, err := s.Render.Render(r.Context(), node)
	if errors.Is(err, ErrUnknownNode) {
		reply(w, r, http.StatusBadRequest, map[string]any{"error": err.Error(), "nodes": s.Render.Nodes()})
		return
	}
	if err != nil {
		s.Store.refuse("render_failed")
		s.Log.Error("render failed, the enrollment stays pending", "node", node, "user_code", e.UserCode, "err", err)
		reply(w, r, http.StatusInternalServerError, map[string]any{"error": "the config did not render; see the server log"})
		return
	}
	e, _, err = s.Store.Approve(code, node, who, cfg)
	if err != nil {
		reply(w, r, http.StatusConflict, map[string]any{"error": err.Error(), "phase": e.Phase})
		return
	}
	known := s.MACs[node]
	mismatch := known != "" && !strings.EqualFold(known, e.Device.MAC)
	s.Log.Info("enrollment approved", "user_code", e.UserCode, "node", node, "uuid", e.Device.UUID,
		"mac", e.Device.MAC, "mac_mismatch", mismatch, "approver", who)
	msg := fmt.Sprintf("**Talos enrollment** `%s` approved as **%s** by %s. Waiting for the node to fetch its config.", e.UserCode, node, who)
	if mismatch {
		msg += fmt.Sprintf("\nThe device's MAC `%s` is not %s's MAC in the UniFi client list.", discordSafe(e.Device.MAC), node)
	}
	s.Out.Send(normUUID(e.Device.UUID), msg)
	reply(w, r, http.StatusOK, map[string]any{"user_code": e.UserCode, "node": node, "phase": e.Phase, "mac_mismatch": mismatch})
}

func (s *Server) deny(w http.ResponseWriter, r *http.Request) {
	who := login(r)
	e, err := s.Store.Deny(r.PathValue("code"), who)
	switch {
	case errors.Is(err, ErrUnknownCode):
		reply(w, r, http.StatusNotFound, map[string]any{"error": err.Error()})
		return
	case err != nil:
		reply(w, r, http.StatusConflict, map[string]any{"error": err.Error(), "phase": e.Phase})
		return
	}
	s.Log.Info("enrollment denied", "user_code", e.UserCode, "uuid", e.Device.UUID, "mac", e.Device.MAC, "approver", who)
	s.Out.Send(normUUID(e.Device.UUID), fmt.Sprintf("**Talos enrollment** `%s` denied by %s. The server refuses uuid `%s` until it restarts.",
		e.UserCode, who, discordSafe(e.Device.UUID)))
	reply(w, r, http.StatusOK, map[string]any{"user_code": e.UserCode, "phase": e.Phase})
}

func (s *Server) withSuggestions(list []Enrollment) []Enrollment {
	for i := range list {
		list[i].Suggested = s.suggest(list[i].Device.MAC)
	}
	return list
}

func (s *Server) pending(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"enrollments": s.withSuggestions(s.Store.List()), "nodes": s.Render.Nodes()})
}

func (s *Server) index(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'")
	_ = indexTmpl.Execute(w, map[string]any{
		"Enrollments": s.withSuggestions(s.Store.List()),
		"Nodes":       s.Render.Nodes(),
		"Code":        normUserCode(r.URL.Query().Get("code")),
		"Login":       login(r),
	})
}
