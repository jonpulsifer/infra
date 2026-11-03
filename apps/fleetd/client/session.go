package client

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"

	"github.com/google/go-tpm/legacy/tpm2"

	"github.com/jonpulsifer/infra/apps/fleetd/protocol"
)

// Session is a passed attestation's session, which a boot's later requests
// go over: each is signed by the session's AK, as the confirm is. The AK's
// wrapped blobs load again under the SRK, which the TPM derives the same
// until it is cleared, so nothing stays loaded between requests.
type Session struct {
	ID    string
	Nonce []byte

	akPublic, akPrivate []byte
}

// Sign has the session's AK sign SHA-256 of data.
func (s *Session) Sign(rw io.ReadWriter, data []byte) ([]byte, error) {
	srk, _, err := tpm2.CreatePrimary(rw, tpm2.HandleOwner, tpm2.PCRSelection{}, "", "", SRKTemplate)
	if err != nil {
		return nil, fmt.Errorf("create SRK: %w", err)
	}
	ak, _, err := tpm2.Load(rw, srk, "", s.akPublic, s.akPrivate)
	_ = tpm2.FlushContext(rw, srk)
	if err != nil {
		return nil, fmt.Errorf("load AK: %w", err)
	}
	defer tpm2.FlushContext(rw, ak)
	return akSign(rw, ak, *AKTemplate.ECCParameters.Sign, data)
}

// ErrNoBoot is fleetd answering that it serves this session no boot
// route: a fleetd without the boot executor, or one that holds no run for
// the session.
var ErrNoBoot = errors.New("fleetd serves no boot run for this session")

// Boot sends a boot's requests over a passed session, numbering them.
type Boot struct {
	BaseURL string
	HTTP    *http.Client
	TPM     io.ReadWriter
	Session *Session

	mu  sync.Mutex
	seq uint64
}

// Run asks fleetd what this boot does.
func (b *Boot) Run(ctx context.Context) (protocol.BootRun, error) {
	var run protocol.BootRun
	err := b.send(ctx, protocol.PathBootRun, nil, &run)
	return run, err
}

// Report tells fleetd where the run is. An error means fleetd did not take
// it, and the run goes no further.
func (b *Boot) Report(ctx context.Context, r protocol.BootReport) error {
	return b.send(ctx, protocol.PathBootReport, &r, nil)
}

func (b *Boot) send(ctx context.Context, route string, report *protocol.BootReport, out any) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.seq++
	sig, err := b.Session.Sign(b.TPM, protocol.BootData(b.Session.Nonce, route, b.seq, report))
	if err != nil {
		return fmt.Errorf("sign the request: %w", err)
	}
	cfg := Config{BaseURL: b.BaseURL, HTTP: b.HTTP}
	err = post(ctx, cfg, strings.Replace(route, "{session}", b.Session.ID, 1), protocol.BootRequest{Seq: b.seq, Report: report, Signature: sig}, out)
	var refused *RefusedError
	if errors.As(err, &refused) && (refused.Status == http.StatusNotFound || refused.Status == http.StatusMethodNotAllowed) {
		return fmt.Errorf("%w (%d)", ErrNoBoot, refused.Status)
	}
	return err
}
