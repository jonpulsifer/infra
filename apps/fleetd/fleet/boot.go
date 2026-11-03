package fleet

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"

	"github.com/google/go-tpm/legacy/tpm2"

	"github.com/jonpulsifer/infra/apps/fleetd/protocol"
)

// BootServer serves fleet-boot's two routes under the device flow, over the
// session of the machine's intake pass: the run, which carries the inputs
// Config.Workflow puts in a Workflow's hardwareMap, and each step's report,
// which the attempt records. A request counts only when the session's AK
// signed it and its sequence number is above the last one taken, so the
// channel is the attestation's and never the MAC's.
type BootServer struct {
	Attempts *Attempts
	Config   Config
	// Device reads the device NetBox holds by name, for its install disk
	// and class.
	Device func(ctx context.Context, name string) (Device, error)
}

// Handler serves the routes, rooted where the device flow is.
func (b *BootServer) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST "+protocol.PathBootRun, b.run)
	mux.HandleFunc("POST "+protocol.PathBootReport, b.report)
	return mux
}

var errSignature = errors.New("the request is not signed by the session's AK")

// verifyBoot checks the request's signature, ECDSA over SHA-256 by the AK
// the session bound, of what the route and number say.
func verifyBoot(a *Attempt, route string, req protocol.BootRequest) error {
	key, err := x509.ParsePKIXPublicKey(a.AK)
	pub, ok := key.(*ecdsa.PublicKey)
	if err != nil || !ok {
		return fmt.Errorf("the session's AK does not parse: %v", err)
	}
	sig, err := tpm2.DecodeSignature(bytes.NewBuffer(req.Signature))
	if err != nil || sig.Alg != tpm2.AlgECDSA || sig.ECC == nil || sig.ECC.HashAlg != tpm2.AlgSHA256 {
		return fmt.Errorf("%w: it is not ECDSA over SHA-256", errSignature)
	}
	if !ecdsa.Verify(pub, protocol.BootDigest(a.Nonce, route, req.Seq, req.Report), sig.ECC.R, sig.ECC.S) {
		return errSignature
	}
	return nil
}

func writeBoot(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func refuseBoot(w http.ResponseWriter, code int, reason string) {
	writeBoot(w, code, protocol.Verdict{Reason: "boot", Detail: []string{reason}})
}

// maxDetail caps a report's reason, as fleet-boot does, before it reaches
// the log, the record and NetBox's journal.
const maxDetail = 2000

// shape checks what a request holds before anything is taken: the run
// request no report, the report request one with a known step and phase.
func shape(route string, req *protocol.BootRequest) error {
	rep := req.Report
	if route == protocol.PathBootRun {
		if rep != nil {
			return errors.New("the run request carries no report")
		}
		return nil
	}
	if rep == nil {
		return errors.New("the report request carries no report")
	}
	switch rep.Step {
	case protocol.StepWipe, protocol.StepInstall, protocol.StepNextBoot, protocol.StepReboot:
	default:
		return fmt.Errorf("step %q", rep.Step)
	}
	switch rep.Phase {
	case protocol.PhaseStarted, protocol.PhaseSucceeded, protocol.PhaseFailed:
	default:
		return fmt.Errorf("phase %q", rep.Phase)
	}
	return nil
}

// accept decodes the request, checks its shape, and takes it over the
// session: only a signed request for the session's own run moves the
// record's sequence number.
func (b *BootServer) accept(w http.ResponseWriter, r *http.Request, route string) (Attempt, protocol.BootRequest, bool) {
	var req protocol.BootRequest
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		refuseBoot(w, http.StatusBadRequest, err.Error())
		return Attempt{}, req, false
	}
	if err := shape(route, &req); err != nil {
		refuseBoot(w, http.StatusBadRequest, err.Error())
		return Attempt{}, req, false
	}
	session := r.PathValue("session")
	a, err := b.Attempts.take(session, req.Seq, func(a *Attempt) error {
		if err := verifyBoot(a, route, req); err != nil {
			return err
		}
		if req.Report != nil && req.Report.Run != a.Name {
			return fmt.Errorf("%w: the report names %q, and the session's run is %s", errBadReport, req.Report.Run, a.Name)
		}
		return nil
	})
	switch {
	case errors.Is(err, errBadReport):
		refuseBoot(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, ErrNotFound):
		refuseBoot(w, http.StatusNotFound, "no run holds this session")
	case errors.Is(err, errSignature):
		log.Printf("boot: session %s: %v", session, err)
		refuseBoot(w, http.StatusForbidden, err.Error())
	case errors.Is(err, errStale):
		refuseBoot(w, http.StatusConflict, err.Error())
	case err != nil:
		log.Printf("boot: session %s: %v", session, err)
		refuseBoot(w, http.StatusInternalServerError, "internal error")
	default:
		return a, req, true
	}
	return Attempt{}, req, false
}

func (b *BootServer) run(w http.ResponseWriter, r *http.Request) {
	a, _, ok := b.accept(w, r, protocol.PathBootRun)
	if !ok {
		return
	}
	d, err := b.Device(r.Context(), a.Labels[NodeLabel])
	if err != nil {
		log.Printf("boot: %s: read %s from NetBox: %v", a.Name, a.Labels[NodeLabel], err)
		refuseBoot(w, http.StatusServiceUnavailable, "NetBox did not answer")
		return
	}
	if err := b.Attempts.started(a.Name); err != nil {
		refuseBoot(w, statusOf(err), err.Error())
		return
	}
	run := BootRun(a, d, b.Config)
	Audit("fleet.boot", b.Config.Site, d, a.Name, "run sent to fleet-boot")
	writeBoot(w, http.StatusOK, run)
}

func (b *BootServer) report(w http.ResponseWriter, r *http.Request) {
	a, req, ok := b.accept(w, r, protocol.PathBootReport)
	if !ok {
		return
	}
	rep := *req.Report
	if len(rep.Detail) > maxDetail {
		rep.Detail = strings.ToValidUTF8(rep.Detail[:maxDetail], "")
	}
	if err := b.Attempts.report(a.Name, rep); err != nil {
		refuseBoot(w, statusOf(err), err.Error())
		return
	}
	log.Printf("boot: %s: %s %s %s", a.Name, rep.Step, rep.Phase, rep.Detail)
	writeBoot(w, http.StatusOK, map[string]string{"status": "recorded"})
}

// statusOf is the answer to a store error: a report no run takes is the
// client's fault, a run that ended or moved on a conflict, and a run that
// is gone not found.
func statusOf(err error) int {
	switch {
	case errors.Is(err, errBadReport):
		return http.StatusBadRequest
	case errors.Is(err, errStale):
		return http.StatusConflict
	case errors.Is(err, ErrNotFound):
		return http.StatusNotFound
	}
	log.Printf("boot: %v", err)
	return http.StatusInternalServerError
}

// BootRun is the run an attempt asks of fleet-boot: its hardwareMap's
// inputs, by the Template's names, and the device's install disk. A Talos
// class that pins its metal image installs that, and fleet-boot writes the
// code into its META.
func BootRun(a Attempt, d Device, c Config) protocol.BootRun {
	hm, _ := a.Spec["hardwareMap"].(map[string]any)
	str := func(k string) string { s, _ := hm[k].(string); return s }
	run := protocol.BootRun{
		Run:            a.Name,
		Action:         a.Labels[ActionLabel],
		Attest:         str("attest") == "true",
		Wipe:           str("wipe") == "true",
		Retire:         str("retire") == "true",
		Install:        str("install") == "true",
		Disk:           d.Disk,
		DiskSerial:     str("install_disk_serial"),
		InstallerImage: str("installer_image"),
		ImageURL:       str("image_url"),
		ImageDigest:    str("image_digest"),
		ImageFormat:    str("image_format"),
		PayloadKind:    str("payload_kind"),
		OS:             str("os"),
		SeedURL:        str("seed_url"),
	}
	if class, ok := c.Classes[d.Class]; ok {
		if run.PayloadKind == "" {
			run.PayloadKind = class.PayloadKind
		}
		if run.OS == "" {
			run.OS = class.OS
		}
		if run.Install && run.ImageURL == "" && class.TalosImage() {
			run.ImageURL, run.ImageDigest, run.ImageFormat = class.Image, class.ImageDigest, class.ImageFormat
		}
	}
	return run
}

// BindBoot is the verifier's hand-over of a passed intake session: the
// node's unfinished attempt takes it, and fleet-boot's requests go over it.
func (b *BootServer) BindBoot(_ context.Context, bs BootSession) {
	name, err := b.Attempts.Bind(bs)
	switch {
	case err != nil:
		log.Printf("boot: bind session %s to %s: %v", bs.ID, bs.Node, err)
	case name == "":
		log.Printf("boot: %s attested and has no run to take", bs.Node)
	default:
		log.Printf("boot: %s's session %s holds %s", bs.Node, bs.ID, name)
	}
}

// Device reads one device of the site from NetBox by name.
func (r *Reconciler) Device(ctx context.Context, name string) (Device, error) {
	devices, err := r.NetBox.Devices(ctx, r.Config.Site)
	if err != nil {
		return Device{}, err
	}
	for _, d := range devices {
		if d.Name == name {
			return d, nil
		}
	}
	return Device{}, fmt.Errorf("NetBox lists no device %s", name)
}
