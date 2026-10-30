//go:build cgo

package client

import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"
	"math/big"
	"strings"
	"sync"
	"testing"
	"time"

	tools "github.com/google/go-tpm-tools/client"
	"github.com/google/go-tpm-tools/simulator"
	"github.com/google/go-tpm/legacy/tpm2"
	"github.com/google/go-tpm/legacy/tpm2/credactivation"
	"github.com/google/go-tpm/tpmutil"

	"github.com/jonpulsifer/infra/apps/fleetd/protocol"
)

func newSim(t *testing.T) *simulator.Simulator {
	t.Helper()
	sim, err := simulator.Get()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { sim.Close() })
	return sim
}

const ekIndexAttrs = tpm2.AttrOwnerWrite | tpm2.AttrOwnerRead | tpm2.AttrAuthRead | tpm2.AttrNoDA

func defineNV(t *testing.T, rw io.ReadWriter, index uint32, attrs tpm2.NVAttr, auth string, data []byte) {
	t.Helper()
	h := tpmutil.Handle(index)
	if err := tpm2.NVDefineSpace(rw, tpm2.HandleOwner, h, "", auth, nil, attrs, uint16(len(data))); err != nil {
		t.Fatal(err)
	}
	writer, pw := tpm2.HandleOwner, ""
	if attrs&tpm2.AttrOwnerWrite == 0 {
		writer, pw = h, auth
	}
	for off := 0; off < len(data); off += nvChunk {
		if err := tpm2.NVWrite(rw, writer, h, pw, data[off:min(off+nvChunk, len(data))], uint16(off)); err != nil {
			t.Fatal(err)
		}
	}
}

// makeEK creates the EK a template makes, as the manufacturer does before
// it certifies it.
func makeEK(t *testing.T, rw io.ReadWriter, tmpl tpm2.Public) crypto.PublicKey {
	t.Helper()
	h, pub, err := tpm2.CreatePrimary(rw, tpm2.HandleEndorsement, tpm2.PCRSelection{}, "", "", tmpl)
	if err != nil {
		t.Fatal(err)
	}
	_ = tpm2.FlushContext(rw, h)
	return pub
}

func certify(t *testing.T, pub crypto.PublicKey) []byte {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "Test TPM Maker"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, pub, key)
	if err != nil {
		t.Fatal(err)
	}
	return der
}

func hashOf(t *testing.T, pub crypto.PublicKey) string {
	t.Helper()
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	return hashHex(der)
}

// activateWith wraps a secret to e the way the service does and has the TPM
// unwrap it with a fresh AK.
func activateWith(t *testing.T, rw io.ReadWriter, e *EK) {
	t.Helper()
	srk, _, err := tpm2.CreatePrimary(rw, tpm2.HandleOwner, tpm2.PCRSelection{}, "", "", SRKTemplate)
	if err != nil {
		t.Fatal(err)
	}
	priv, pub, _, _, _, err := tpm2.CreateKey(rw, srk, tpm2.PCRSelection{}, "", "", AKTemplate)
	if err != nil {
		t.Fatal(err)
	}
	ak, _, err := tpm2.Load(rw, srk, "", pub, priv)
	_ = tpm2.FlushContext(rw, srk)
	if err != nil {
		t.Fatal(err)
	}
	defer tpm2.FlushContext(rw, ak)
	akPub, err := tpm2.DecodePublic(pub)
	if err != nil {
		t.Fatal(err)
	}
	name, err := akPub.Name()
	if err != nil {
		t.Fatal(err)
	}
	ekPub, err := x509.ParsePKIXPublicKey(e.PublicDER)
	if err != nil {
		t.Fatal(err)
	}
	secret := []byte("sixteen byte key")
	cred, encSecret, err := credactivation.Generate(name.Digest, ekPub, 16, secret)
	if err != nil {
		t.Fatal(err)
	}
	got, err := activate(rw, ak, e, protocol.Challenge{Credential: cred, Secret: encSecret})
	if err != nil {
		t.Fatalf("activate with the %s EK: %v", e.Alg, err)
	}
	if !bytes.Equal(got, secret) {
		t.Fatalf("the %s EK released another secret", e.Alg)
	}
}

func TestDiscoveryWithNothingInNVKeepsTheDefaults(t *testing.T) {
	sim := newSim(t)
	eks, err := DiscoverEKs(sim)
	if err != nil {
		t.Fatal(err)
	}
	want := hashOf(t, makeEK(t, sim, tools.DefaultEKTemplateRSA()))
	if len(eks) != 1 || eks[0].Alg != "rsa" || eks[0].Hash != want || eks[0].Cert != nil || eks[0].TemplateNV || eks[0].NonceNV {
		t.Fatalf("got %+v, want the RSA EK %s alone", eks[0], want)
	}
	activateWith(t, sim, eks[0])
}

func TestDiscoveryWithDefaultCertificates(t *testing.T) {
	sim := newSim(t)
	rsa := makeEK(t, sim, tools.DefaultEKTemplateRSA())
	ecc := makeEK(t, sim, tools.DefaultEKTemplateECC())
	// Some TPMs pad a certificate's index past its DER.
	defineNV(t, sim, 0x01c00002, ekIndexAttrs, "", append(certify(t, rsa), 0xff, 0xff))
	defineNV(t, sim, 0x01c0000a, ekIndexAttrs, "", certify(t, ecc))
	eks, err := DiscoverEKs(sim)
	if err != nil {
		t.Fatal(err)
	}
	if len(eks) != 2 || eks[0].Alg != "ecc" || eks[0].Hash != hashOf(t, ecc) || eks[1].Alg != "rsa" || eks[1].Hash != hashOf(t, rsa) {
		t.Fatalf("got %+v", eks)
	}
	if _, err := x509.ParseCertificate(eks[1].Cert); err != nil {
		t.Fatalf("the RSA certificate is not trimmed to its DER: %v", err)
	}
	for _, e := range eks {
		activateWith(t, sim, e)
	}
}

// A manufacturer that stores an EK Template and an EK Nonce certifies the
// key their calculation makes, which is not the default's.
func TestDiscoveryReconstructsTheManufacturerTemplateAndNonce(t *testing.T) {
	sim := newSim(t)
	nonce := []byte("a nonce of fewer bytes than unique")
	rsaTemplate := DefaultEKTemplateRSA()
	rsaTemplate.RSAParameters.ModulusRaw = nil
	rsaWant := DefaultEKTemplateRSA()
	copy(rsaWant.RSAParameters.ModulusRaw, nonce)
	eccTemplate := DefaultEKTemplateECC()
	eccTemplate.Attributes |= tpm2.FlagNoDA
	eccWant := eccTemplate
	eccWant.ECCParameters = &tpm2.ECCParams{
		Symmetric: eccTemplate.ECCParameters.Symmetric,
		CurveID:   tpm2.CurveNISTP256,
		Point:     tpm2.ECPoint{XRaw: append([]byte(nil), nonce[:32]...), YRaw: make([]byte, 32)},
	}
	rsa, ecc := makeEK(t, sim, rsaWant), makeEK(t, sim, eccWant)
	if hashOf(t, rsa) == hashOf(t, makeEK(t, sim, DefaultEKTemplateRSA())) {
		t.Fatal("the nonce did not change the RSA EK")
	}
	defineNV(t, sim, 0x01c00002, ekIndexAttrs, "", certify(t, rsa))
	defineNV(t, sim, 0x01c00003, ekIndexAttrs, "", nonce)
	defineNV(t, sim, 0x01c00004, ekIndexAttrs, "", encode(t, rsaTemplate))
	defineNV(t, sim, 0x01c0000a, ekIndexAttrs, "", certify(t, ecc))
	defineNV(t, sim, 0x01c0000b, ekIndexAttrs, "", nonce[:32])
	defineNV(t, sim, 0x01c0000c, ekIndexAttrs, "", encode(t, eccTemplate))

	eks, err := DiscoverEKs(sim)
	if err != nil {
		t.Fatal(err)
	}
	if len(eks) != 2 || eks[0].Hash != hashOf(t, ecc) || eks[1].Hash != hashOf(t, rsa) {
		t.Fatalf("got %+v", eks)
	}
	for _, e := range eks {
		if !e.TemplateNV || !e.NonceNV {
			t.Errorf("%s: NV template %v nonce %v", e.Alg, e.TemplateNV, e.NonceNV)
		}
		activateWith(t, sim, e)
	}
}

func TestDiscoveryRefusesWhatNVCannotJustify(t *testing.T) {
	rsaDefault := func(sim io.ReadWriter) crypto.PublicKey { return makeEK(t, sim, DefaultEKTemplateRSA()) }
	for _, c := range []struct {
		name  string
		setup func(sim io.ReadWriter)
		class error
	}{
		{"a certificate for another key", func(sim io.ReadWriter) {
			other := makeEK(t, sim, DefaultEKTemplateECC())
			defineNV(t, sim, 0x01c00002, ekIndexAttrs, "", certify(t, other))
		}, ErrEKCertMismatch},
		{"a certificate that does not parse", func(sim io.ReadWriter) {
			defineNV(t, sim, 0x01c00002, ekIndexAttrs, "", []byte{0x30, 0x03, 1, 2, 3})
		}, ErrNVMalformed},
		{"a malformed template", func(sim io.ReadWriter) {
			defineNV(t, sim, 0x01c00002, ekIndexAttrs, "", certify(t, rsaDefault(sim)))
			defineNV(t, sim, 0x01c00004, ekIndexAttrs, "", []byte{0x00, 0x01, 0x00})
		}, ErrNVMalformed},
		{"an oversized nonce", func(sim io.ReadWriter) {
			defineNV(t, sim, 0x01c00003, ekIndexAttrs, "", make([]byte, 300))
			defineNV(t, sim, 0x01c00004, ekIndexAttrs, "", encode(t, DefaultEKTemplateRSA()))
		}, ErrNVMalformed},
		{"a nonce without a template", func(sim io.ReadWriter) {
			defineNV(t, sim, 0x01c00003, ekIndexAttrs, "", []byte{1, 2, 3})
		}, ErrUnsupportedEKProfile},
		{"a certificate index never written", func(sim io.ReadWriter) {
			if err := tpm2.NVDefineSpace(sim, tpm2.HandleOwner, 0x01c0000a, "", "", nil, ekIndexAttrs, 64); err != nil {
				t.Fatal(err)
			}
		}, ErrNVMalformed},
		{"a certificate behind a password", func(sim io.ReadWriter) {
			defineNV(t, sim, 0x01c0000a, tpm2.AttrAuthWrite|tpm2.AttrAuthRead|tpm2.AttrNoDA, "secret", []byte{0x30})
		}, ErrNVPermission},
		{"a template only a policy reads", func(sim io.ReadWriter) {
			defineNV(t, sim, 0x01c00004, tpm2.AttrOwnerWrite|tpm2.AttrPolicyRead, "", encode(t, DefaultEKTemplateRSA()))
		}, ErrNVPermission},
	} {
		t.Run(c.name, func(t *testing.T) {
			sim := newSim(t)
			c.setup(sim)
			eks, err := DiscoverEKs(sim)
			if !errors.Is(err, c.class) {
				t.Fatalf("got %+v, %v; want %v", eks, err, c.class)
			}
		})
	}
}

// failingNVRead passes every command to the TPM but TPM2_NV_Read.
type failingNVRead struct{ io.ReadWriter }

func (f failingNVRead) Write(b []byte) (int, error) {
	if len(b) >= 10 && binary.BigEndian.Uint32(b[6:10]) == uint32(tpm2.CmdReadNV) {
		return 0, io.ErrClosedPipe
	}
	return f.ReadWriter.Write(b)
}

func TestDiscoveryFailsOnAnNVReadFailure(t *testing.T) {
	sim := newSim(t)
	defineNV(t, sim, 0x01c00002, ekIndexAttrs, "", certify(t, makeEK(t, sim, DefaultEKTemplateRSA())))
	_, err := DiscoverEKs(failingNVRead{sim})
	var nv *NVError
	if !errors.Is(err, ErrNVTransport) || !errors.As(err, &nv) || nv.Index != 0x01c00002 {
		t.Fatalf("got %v", err)
	}
}

// lockedTPM hands the simulator one command and its answer at a time.
type lockedTPM struct {
	mu sync.Mutex
	rw io.ReadWriter
}

func (l *lockedTPM) Write(b []byte) (int, error) {
	l.mu.Lock()
	n, err := l.rw.Write(b)
	if err != nil {
		l.mu.Unlock()
	}
	return n, err
}

func (l *lockedTPM) Read(b []byte) (int, error) {
	defer l.mu.Unlock()
	return l.rw.Read(b)
}

func TestConcurrentDiscoveryFindsTheSameKeys(t *testing.T) {
	sim := newSim(t)
	nonce := []byte{9, 8, 7}
	want := DefaultEKTemplateRSA()
	copy(want.RSAParameters.ModulusRaw, nonce)
	rsa := makeEK(t, sim, want)
	ecc := makeEK(t, sim, DefaultEKTemplateECC())
	defineNV(t, sim, 0x01c00002, ekIndexAttrs, "", certify(t, rsa))
	defineNV(t, sim, 0x01c00003, ekIndexAttrs, "", nonce)
	defineNV(t, sim, 0x01c00004, ekIndexAttrs, "", encode(t, DefaultEKTemplateRSA()))
	defineNV(t, sim, 0x01c0000a, ekIndexAttrs, "", certify(t, ecc))

	tpm := &lockedTPM{rw: sim}
	var wg sync.WaitGroup
	// The simulator holds three transient objects; each discovery holds one.
	for range 3 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 4 {
				eks, err := DiscoverEKs(tpm)
				if err != nil {
					t.Error(err)
					return
				}
				if len(eks) != 2 || eks[0].Hash != hashOf(t, ecc) || eks[1].Hash != hashOf(t, rsa) {
					t.Errorf("a discovery found other keys: %+v", eks)
				}
			}
		}()
	}
	wg.Wait()
	if hex.EncodeToString(encode(t, DefaultEKTemplateRSA())) != shippedTemplates["rsa"] ||
		hex.EncodeToString(encode(t, DefaultEKTemplateECC())) != shippedTemplates["ecc"] {
		t.Fatal("discovery changed a default template")
	}
}

// An identity whose blobs the shipped templates made, before EK discovery
// read NV, loads under the SRK after a reboot and certifies the same LDevID
// key for a renewal.
func TestAnIdentityFromTheShippedTemplatesRenewsAfterAReboot(t *testing.T) {
	sim := newSim(t)
	shipped := func(name string) tpm2.Public {
		b, err := hex.DecodeString(shippedTemplates[name])
		if err != nil {
			t.Fatal(err)
		}
		p, err := tpm2.DecodePublic(b)
		if err != nil {
			t.Fatal(err)
		}
		return p
	}
	srk, _, err := tpm2.CreatePrimary(sim, tpm2.HandleOwner, tpm2.PCRSelection{}, "", "", shipped("srk"))
	if err != nil {
		t.Fatal(err)
	}
	akPriv, akPub, _, _, _, err := tpm2.CreateKey(sim, srk, tpm2.PCRSelection{}, "", "", shipped("ak"))
	if err != nil {
		t.Fatal(err)
	}
	ldPriv, ldPub, _, _, _, err := tpm2.CreateKey(sim, srk, tpm2.PCRSelection{}, "", "", shipped("ldevid"))
	if err != nil {
		t.Fatal(err)
	}
	_ = tpm2.FlushContext(sim, srk)
	before := makeEK(t, sim, shipped("rsa"))

	if err := sim.Reset(); err != nil {
		t.Fatal(err)
	}
	nonce := bytes.Repeat([]byte{7}, 32)
	ev, err := renewEvidence(sim, protocol.DevID{AKPublic: akPub, AKPrivate: akPriv, LDevIDPublic: ldPub, LDevIDPrivate: ldPriv}, nonce, []int{0, 7})
	if err != nil {
		t.Fatalf("the shipped identity does not load after a reboot: %v", err)
	}
	att, err := tpm2.DecodeAttestationData(ev.LDevID.Attestation)
	if err != nil || !bytes.Equal(att.ExtraData, nonce) || !bytes.Equal(ev.LDevID.Public, ldPub) {
		t.Fatalf("certification %+v %v", att, err)
	}
	eks, err := DiscoverEKs(sim)
	if err != nil || len(eks) != 1 || eks[0].Hash != hashOf(t, before) {
		t.Fatalf("the EK after the reboot is not the shipped one: %+v %v", eks, err)
	}
}

// A TPM that certifies its EKs only in the High Range has certificates this
// client cannot use; sending its default RSA EK as uncertified would hide
// them.
func TestDiscoveryRefusesAHighRangeOnlyTPM(t *testing.T) {
	t.Run("High Range alone", func(t *testing.T) {
		sim := newSim(t)
		defineNV(t, sim, 0x01c00014, ekIndexAttrs, "", certify(t, makeEK(t, sim, DefaultEKTemplateECC())))
		_, err := DiscoverEKs(sim)
		if !errors.Is(err, ErrUnsupportedEKProfile) || !strings.Contains(err.Error(), "0x1c00014") {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("beside the Low Range", func(t *testing.T) {
		sim := newSim(t)
		rsa := makeEK(t, sim, DefaultEKTemplateRSA())
		defineNV(t, sim, 0x01c00002, ekIndexAttrs, "", certify(t, rsa))
		defineNV(t, sim, 0x01c00014, ekIndexAttrs, "", []byte{0x30})
		eks, err := DiscoverEKs(sim)
		if err != nil || len(eks) != 1 || eks[0].Hash != hashOf(t, rsa) {
			t.Fatalf("got %+v %v", eks, err)
		}
	})
	t.Run("a chain is no certificate", func(t *testing.T) {
		sim := newSim(t)
		defineNV(t, sim, 0x01c00100, ekIndexAttrs, "", []byte{0x30})
		if eks, err := DiscoverEKs(sim); err != nil || len(eks) != 1 || eks[0].Cert != nil {
			t.Fatalf("got %+v %v", eks, err)
		}
	})
}

// Activation recreates the key from the template discovery resolved, and
// refuses one that makes another key.
func TestActivationUsesTheResolvedTemplate(t *testing.T) {
	sim := newSim(t)
	nonce := []byte{4, 5, 6}
	want := DefaultEKTemplateRSA()
	copy(want.RSAParameters.ModulusRaw, nonce)
	defineNV(t, sim, 0x01c00002, ekIndexAttrs, "", certify(t, makeEK(t, sim, want)))
	defineNV(t, sim, 0x01c00003, ekIndexAttrs, "", nonce)
	defineNV(t, sim, 0x01c00004, ekIndexAttrs, "", encode(t, DefaultEKTemplateRSA()))
	eks, err := DiscoverEKs(sim)
	if err != nil || len(eks) != 1 {
		t.Fatalf("got %+v %v", eks, err)
	}
	if !bytes.Equal(eks[0].Template, encode(t, want)) {
		t.Fatalf("resolved template %x", eks[0].Template)
	}
	activateWith(t, sim, eks[0])

	other := *eks[0]
	other.Template = encode(t, DefaultEKTemplateRSA())
	if _, err := loadEK(sim, &other); err == nil || !strings.Contains(err.Error(), "not the one discovery found") {
		t.Fatalf("a template for another key loaded: %v", err)
	}
}
