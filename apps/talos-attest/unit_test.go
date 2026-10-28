package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"math/big"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/go-attestation/attest"

	"github.com/jonpulsifer/infra/apps/talos-attest/protocol"
)

// rocaModulus builds a 2048-bit number with the ROCA fingerprint: N = 65537^a
// mod M, plus a multiple of M, where M is the product of the ROCA primes.
func rocaModulus() *big.Int {
	m := big.NewInt(1)
	for _, p := range rocaPrimes {
		m.Mul(m, big.NewInt(p))
	}
	n := new(big.Int).Exp(big.NewInt(65537), big.NewInt(12345), m)
	k := new(big.Int).Lsh(big.NewInt(1), 2047)
	k.Div(k, m).Add(k, big.NewInt(1))
	return n.Add(n, k.Mul(k, m))
}

func TestROCA(t *testing.T) {
	if n := rocaModulus(); !rocaVulnerable(n) || n.BitLen() != 2048 {
		t.Fatalf("fingerprinted modulus not detected (bits %d)", n.BitLen())
	}
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	if rocaVulnerable(key.N) {
		t.Fatal("a fresh Go RSA key carries the ROCA fingerprint")
	}
	riptide, err := x509.ParseCertificate(readFile(t, "testdata/riptide-ek-rsa.der"))
	if err != nil {
		t.Fatal(err)
	}
	if rocaVulnerable(riptide.PublicKey.(*rsa.PublicKey).N) {
		t.Fatal("riptide's RSA EK reads as ROCA-weak")
	}
}

func pinnedRoots(t *testing.T) *EKRoots {
	t.Helper()
	r, err := LoadEKRoots("roots")
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func ekMsg(t *testing.T, path string) protocol.EK {
	t.Helper()
	der := readFile(t, path)
	c, err := attest.ParseEKCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	pub, err := x509.MarshalPKIXPublicKey(c.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	return protocol.EK{Public: pub, Cert: der}
}

// The EK certificates read from riptide's Infineon and optiplex's Nuvoton
// TPMs chain to the pinned roots, and riptide's RSA hash is the one SPIRE's
// allow list holds.
func TestRealEKsChainToPinnedRoots(t *testing.T) {
	roots := pinnedRoots(t)
	for _, c := range []struct{ file, alg, issuer, hash string }{
		{"riptide-ek-rsa.der", "rsa", "Infineon OPTIGA(TM) TPM 2.0 RSA CA 042", "a4c83508a80e37c4c10334e4ecd951fe7aef56ce757b9a40e8a4e38be146b3b1"},
		{"riptide-ek-ecc.der", "ecc", "Infineon OPTIGA(TM) TPM 2.0 ECC CA 042", "9dbf73ddfd2f91eb92b0d7b2027344c6fe1dea0ea3ed2b4997dd5268de3eb7ba"},
		{"optiplex-ek-rsa.der", "rsa", "Nuvoton TPM Root CA 2110", ""},
		{"optiplex-ek-ecc.der", "ecc", "Nuvoton TPM Root CA 2110", ""},
	} {
		ek, err := roots.Verify(ekMsg(t, "testdata/"+c.file), time.Now())
		if err != nil {
			t.Fatalf("%s: %v", c.file, err)
		}
		if ek.Alg != c.alg || ek.Issuer != c.issuer || (c.hash != "" && ek.Hash != c.hash) {
			t.Fatalf("%s: got %s %q %s", c.file, ek.Alg, ek.Issuer, ek.Hash)
		}
	}
}

// SPIRE's server pins the same manufacturer certificates for tpm_devid's
// endorsement_ca_path; the two copies must not drift.
func TestRootsMatchSPIREs(t *testing.T) {
	spire := "../../nix/services/spire/roots"
	theirs, _ := filepath.Glob(filepath.Join(spire, "*.pem"))
	if len(theirs) == 0 {
		t.Skip("no " + spire)
	}
	ours, _ := filepath.Glob("roots/*.pem")
	if len(ours) != len(theirs) {
		t.Fatalf("roots/ has %d certificates, %s has %d", len(ours), spire, len(theirs))
	}
	for _, p := range theirs {
		if !bytes.Equal(readFile(t, p), readFile(t, filepath.Join("roots", filepath.Base(p)))) {
			t.Errorf("roots/%s differs from %s", filepath.Base(p), p)
		}
	}
}

func TestEKRefusals(t *testing.T) {
	roots := pinnedRoots(t)
	riptide := ekMsg(t, "testdata/riptide-ek-rsa.der")
	other := ekMsg(t, "testdata/riptide-ek-ecc.der")
	stranger := newTestCA(t, "Stranger TPM CA", nil, 0)
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	strangerPub, _ := x509.MarshalPKIXPublicKey(key.Public())
	roca := &rsa.PublicKey{N: rocaModulus(), E: 65537}
	rocaPub, _ := x509.MarshalPKIXPublicKey(roca)
	small, _ := rsa.GenerateKey(rand.Reader, 1024)
	smallPub, _ := x509.MarshalPKIXPublicKey(&small.PublicKey)

	for name, c := range map[string]struct {
		ek     protocol.EK
		reason string
	}{
		"no public key":          {protocol.EK{Cert: riptide.Cert}, reasonEKMissing},
		"cert names another key": {protocol.EK{Public: other.Public, Cert: riptide.Cert}, reasonEKMismatch},
		"unpinned manufacturer":  {protocol.EK{Public: strangerPub, Cert: stranger.issueEK(t, key.Public())}, reasonEKChain},
		"ROCA modulus":           {protocol.EK{Public: rocaPub, Cert: stranger.issueEK(t, roca)}, reasonEKROCA},
		"1024-bit RSA":           {protocol.EK{Public: smallPub}, reasonEKWeak},
		"garbage certificate":    {protocol.EK{Public: riptide.Public, Cert: []byte{0x30, 0x03, 0x02, 0x01, 0x01}}, reasonEKChain},
	} {
		_, err := roots.Verify(c.ek, time.Now())
		if got := reasonOf(err); got != c.reason {
			t.Errorf("%s: reason %q (%v), want %q", name, got, err, c.reason)
		}
	}
	// A certificate past its life fails the chain.
	if _, err := roots.Verify(riptide, time.Date(2040, 1, 1, 0, 0, 0, 0, time.UTC)); reasonOf(err) != reasonEKChain {
		t.Fatalf("expired EK certificate: %v", err)
	}
}

func loadPolicy(t *testing.T) *Policy {
	t.Helper()
	p, err := LoadPolicy("policy.yaml")
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func riptideEvents(t *testing.T) []attest.Event {
	t.Helper()
	raw := readFile(t, "testdata/riptide-eventlog.bin")
	el, err := attest.ParseEventLog(raw)
	if err != nil {
		t.Fatal(err)
	}
	events, err := el.Verify(attestPCRs(replayPCRs(t, raw)))
	if err != nil {
		t.Fatal(err)
	}
	return events
}

// The fixture's replay equals the PCRs riptide's TPM reported with
// tpm2_pcrread on 2026-10-28, so the log is the boot that TPM measured.
func TestRiptideLogReplaysToLivePCRs(t *testing.T) {
	live := map[int]string{
		0: "416281eaeb0a66a5148b0b23ddec029196b056cb595473bef1e32d9dc9153b6d",
		4: "424f317cddd21619cbd3debc7bef8338a9c055a80d6599b8309ebc185029e605",
		7: "335eae199d2a650d43a8cf7ee5180b65c3fd42e59a44f5571f609d757c2a0752",
	}
	got := replayPCRs(t, readFile(t, "testdata/riptide-eventlog.bin"))
	for i, want := range live {
		if hex.EncodeToString(got[i]) != want {
			t.Errorf("PCR %d replays to %x, riptide held %s", i, got[i], want)
		}
	}
}

// inRepo skips a test that reads the rest of the repository, which the Nix
// build's source holds none of.
func inRepo(t *testing.T, rel string) string {
	t.Helper()
	path := filepath.Join("../..", rel)
	if _, err := os.Stat(path); err != nil {
		t.Skipf("%s is outside this build's source", rel)
	}
	return path
}

func TestPolicyNamesTheCommittedSecureBootCerts(t *testing.T) {
	dir := inRepo(t, "clusters/folly/talos/secureboot")
	p := loadPolicy(t)
	for file, name := range map[string]string{
		"uki-signing-cert.der":    "FML Secure Boot",
		"hookos-signing-cert.der": "FML HookOS Secure Boot",
	} {
		sum := sha256.Sum256(readFile(t, filepath.Join(dir, file)))
		fp := hex.EncodeToString(sum[:])
		if p.Names[fp] != name {
			t.Errorf("%s (%s) is not named %q in policy.yaml", file, fp, name)
		}
		if !slices.Contains(p.Authorities, fp) || !slices.Contains(p.DB.Required, fp) {
			t.Errorf("%s must be a required db entry and an allowed authority", file)
		}
	}
}

// riptide's real log is a Secure Boot disk boot of Talos: it passes every
// rule but the HookOS authority, which only the attest boot path meets.
func TestPolicyOnRiptidesLog(t *testing.T) {
	p := loadPolicy(t)
	events := riptideEvents(t)
	got := p.Evaluate(events)
	if len(got) != 1 || !strings.Contains(got[0], "The boot path lacks FML HookOS Secure Boot") {
		t.Fatalf("violations %q, want only the missing HookOS authority", got)
	}

	p.RequiredAuthorities = nil
	if got := p.Evaluate(events); len(got) != 0 {
		t.Fatalf("violations %q, want none", got)
	}

	apps := bootApplications(events)
	want := []string{
		"a7aaadd78bbcd9bf1af39ca49fceebba1c386a2e74f652f303fb3c412dcfab4d",
		"643b708da5cc28126900c393e49bd58b45d4dcc342a5c43772752d70be057922",
	}
	if !slices.Equal(apps, want) {
		t.Fatalf("boot applications %q, want systemd-boot then the Talos UKI %q", apps, want)
	}
	p.BootApplications = want
	if got := p.Evaluate(events); len(got) != 0 {
		t.Fatalf("pinned boot applications: %q", got)
	}
	p.BootApplications = want[:1]
	if got := p.Evaluate(events); len(got) != 1 || !strings.Contains(got[0], want[1]) {
		t.Fatalf("an unlisted boot application: %q", got)
	}
}

func TestPolicyRefusesForeignKeys(t *testing.T) {
	events := riptideEvents(t)
	for name, change := range map[string]func(*Policy){
		"another PK": func(p *Policy) { p.PlatformKeys = []string{strings.Repeat("ab", 32)} },
		"a KEK the policy does not know": func(p *Policy) {
			p.KeyExchangeKeys = p.KeyExchangeKeys[:1]
		},
		"Microsoft's UEFI CA not allowed in db": func(p *Policy) { p.DB.Allowed = p.DB.Allowed[1:] },
		"the UKI key not allowed to boot": func(p *Policy) {
			p.Authorities = p.Authorities[1:]
		},
	} {
		p := loadPolicy(t)
		p.RequiredAuthorities = nil
		change(p)
		if got := p.Evaluate(events); len(got) == 0 {
			t.Errorf("%s: no violation", name)
		}
	}
}

// optiplex boots with Secure Boot off and measures an empty SecureBoot
// variable, which fails the policy.
func TestPolicyRefusesSecureBootOff(t *testing.T) {
	raw := readFile(t, "testdata/optiplex-eventlog.bin")
	el, err := attest.ParseEventLog(raw)
	if err != nil {
		t.Fatal(err)
	}
	events, err := el.Verify(attestPCRs(replayPCRs(t, raw)))
	if err != nil {
		t.Fatal(err)
	}
	got := loadPolicy(t).Evaluate(events)
	if len(got) == 0 || !strings.Contains(got[0], "Secure Boot") {
		t.Fatalf("violations %q", got)
	}
}

func TestInventoryReadsMachinesYAML(t *testing.T) {
	inv, err := LoadInventory(inRepo(t, "clusters/folly/inventory/machines.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	m, ok := inv.BySerial(" mxl0172q6l ")
	if !ok || m.Name != "riptide" || normalMAC(m.MAC) != "38:22:e2:2d:96:44" {
		t.Fatalf("riptide by serial: %+v %v", m, ok)
	}
}

func TestCAIssuesDevIDs(t *testing.T) {
	ca := devIDCA(t)
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	cert, err := ca.Issue(key.Public(), "riptide", "MXL0172Q6L", "LDevID", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if cert.Subject.CommonName != "riptide" || cert.Subject.SerialNumber != "MXL0172Q6L" || cert.IsCA {
		t.Fatalf("subject %s", cert.Subject)
	}
	roots, inters := x509.NewCertPool(), x509.NewCertPool()
	roots.AddCert(ca.Chain[len(ca.Chain)-1])
	for _, c := range ca.Chain[:len(ca.Chain)-1] {
		inters.AddCert(c)
	}
	if _, err := cert.Verify(x509.VerifyOptions{Roots: roots, Intermediates: inters, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageAny}}); err != nil {
		t.Fatal(err)
	}
	other, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if _, err := NewCA(other, ca.Chain, time.Hour); err == nil {
		t.Fatal("a CA key that does not match its certificate was accepted")
	}
}

func TestCALoadsTerraformPEM(t *testing.T) {
	ca := devIDCA(t)
	dir := t.TempDir()
	keyDER, err := x509.MarshalPKCS8PrivateKey(ca.key)
	if err != nil {
		t.Fatal(err)
	}
	writePEM(t, filepath.Join(dir, "key.pem"), "PRIVATE KEY", keyDER)
	if err := os.WriteFile(filepath.Join(dir, "chain.pem"), ca.ChainPEM(), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadCA(filepath.Join(dir, "key.pem"), filepath.Join(dir, "chain.pem"), time.Hour); err != nil {
		t.Fatal(err)
	}
}
