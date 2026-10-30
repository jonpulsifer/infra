package attest

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/go-tpm/legacy/tpm2"

	"github.com/jonpulsifer/infra/apps/fleetd/client"
	"github.com/jonpulsifer/infra/apps/fleetd/protocol"
)

// fakeInstaller stands in for fleetd's installer: it records each request
// and answers err.
type fakeInstaller struct {
	mu   sync.Mutex
	err  error
	reqs []InstallRequest
}

func newFakeInstaller(err error) *fakeInstaller { return &fakeInstaller{err: err} }

func (f *fakeInstaller) Install(_ context.Context, req InstallRequest) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reqs = append(f.reqs, req)
	return f.err
}

func (f *fakeInstaller) requests() []InstallRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]InstallRequest(nil), f.reqs...)
}

// installVerifier is a verifier whose NetBox holds testbox, planned and
// bound to the ECC EK keySession makes.
func installVerifier(t *testing.T, f Installer, audit io.Writer) (*Verifier, *fakeNetBox) {
	nb := newFakeNetBox(t)
	nb.add("testbox", "SIM-0001", "planned", "", map[string]any{"approved_ek_hash_ecc": "ek-under-test"})
	return &Verifier{NetBox: nb.client(), Installer: f, Audit: &Audit{W: audit, Site: "folly"}, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Now: time.Now}, nb
}

// keySession is a session with an ECC EK and an AK in AKTemplate's shape,
// the keys a code is wrapped to, without a TPM behind them, for testbox and
// its approved binding as installVerifier's NetBox holds them.
func keySession(t *testing.T, nb *fakeNetBox) *session {
	t.Helper()
	ek, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ak, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := client.AKTemplate
	params := *tmpl.ECCParameters
	params.Point = tpm2.ECPoint{XRaw: ak.X.FillBytes(make([]byte, 32)), YRaw: ak.Y.FillBytes(make([]byte, 32))}
	tmpl.ECCParameters = &params
	akPublic, err := tmpl.Encode()
	if err != nil {
		t.Fatal(err)
	}
	d := nb.bySerial("SIM-0001")
	return &session{
		eks: []VerifiedEK{{Public: &ek.PublicKey, Alg: "ecc", Hash: "ek-under-test"}}, akPublic: akPublic,
		claim:   protocol.Machine{Serial: "SIM-0001"},
		bind:    true,
		machine: Machine{Name: "testbox", Serial: "SIM-0001", NetBoxID: d.ID, Approved: map[string]string{"ecc": "ek-under-test"}},
	}
}

var installRecord = Record{Machine: "testbox", Serial: "SIM-0001", UUID: "4C4C4544-0000-0000-0000-000000000000", Class: "worker-g5"}

func TestInstallCodeAfterTheInstallerRendered(t *testing.T) {
	f := newFakeInstaller(nil)
	var audit strings.Builder
	v, nb := installVerifier(t, f, &audit)
	wrapped, ok := v.installCode(context.Background(), installRecord, keySession(t, nb))
	reqs := f.requests()
	if !ok || len(reqs) != 1 {
		t.Fatalf("issued %v after %d install requests", ok, len(reqs))
	}
	raw, err := base64.RawURLEncoding.DecodeString(reqs[0].Code)
	if err != nil || len(raw) != 32 {
		t.Fatalf("install code %q is not 32 bytes of base64url: %v", reqs[0].Code, err)
	}
	want := InstallRequest{Serial: "SIM-0001", UUID: "4c4c4544-0000-0000-0000-000000000000", Node: "testbox", Class: "worker-g5", Code: reqs[0].Code}
	if reqs[0] != want {
		t.Fatalf("install request %+v, want %+v", reqs[0], want)
	}
	if wrapped.EKHash != "ek-under-test" || len(wrapped.Credential) < 2 || len(wrapped.Secret) < 2 {
		t.Fatalf("wrapped code %+v", wrapped)
	}
	answer, _ := json.Marshal(wrapped)
	if strings.Contains(string(answer), reqs[0].Code) || strings.Contains(string(answer), base64.StdEncoding.EncodeToString(raw)) {
		t.Fatal("the wrapped code carries the plaintext")
	}
	if !strings.Contains(audit.String(), `"event":"attest.install","site":"folly","node":"testbox","serial":"SIM-0001","class":"worker-g5","status":"issued"`) || strings.Contains(audit.String(), reqs[0].Code) {
		t.Fatalf("audit lines:\n%s", audit.String())
	}
}

func TestInstallCodeWithheld(t *testing.T) {
	for _, tc := range []struct {
		name   string
		err    error
		uuid   string
		calls  int
		reason string
		change func(*fakeNetBox, *session)
	}{
		{"no provision", errors.New("no provision asked"), installRecord.UUID, 1, "no provision asked", nil},
		{"cannot render", errors.New("the renderer failed"), installRecord.UUID, 1, "the renderer failed", nil},
		{"no UUID", nil, "", 0, "not 8-4-4-4-12 hex", nil},
		{"not a UUID", nil, "../../etc/passwd", 0, "not 8-4-4-4-12 hex", nil},
		{"braced UUID", nil, "{" + installRecord.UUID + "}", 0, "not 8-4-4-4-12 hex", nil},
		{"no binding", nil, installRecord.UUID, 0, "no approved EK binding", func(_ *fakeNetBox, s *session) { s.machine.Approved = nil }},
		{"binding removed", nil, installRecord.UUID, 0, reasonBinding, func(nb *fakeNetBox, _ *session) {
			nb.set("SIM-0001", func(d *fakeDevice) { delete(d.CustomFields, "approved_ek_hash_ecc") })
		}},
		{"binding replaced", nil, installRecord.UUID, 0, reasonBinding, func(nb *fakeNetBox, _ *session) {
			nb.set("SIM-0001", func(d *fakeDevice) { d.CustomFields["approved_ek_hash_ecc"] = strings.Repeat("ab", 32) })
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFakeInstaller(tc.err)
			var audit strings.Builder
			rec := installRecord
			rec.UUID = tc.uuid
			v, nb := installVerifier(t, f, &audit)
			s := keySession(t, nb)
			if tc.change != nil {
				tc.change(nb, s)
			}
			if _, ok := v.installCode(context.Background(), rec, s); ok {
				t.Fatal("a code the installer did not take")
			}
			if n := len(f.requests()); n != tc.calls {
				t.Fatalf("%d install requests, want %d", n, tc.calls)
			}
			lines := strings.Split(strings.TrimSpace(audit.String()), "\n")
			if len(lines) != 1 || !strings.Contains(lines[0], `"event":"attest.install"`) || !strings.Contains(lines[0], `"status":"withheld"`) || !strings.Contains(lines[0], tc.reason) {
				t.Fatalf("audit lines:\n%s", audit.String())
			}
		})
	}
}
