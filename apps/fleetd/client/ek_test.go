package client

import (
	"bytes"
	"encoding/hex"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/google/go-tpm/legacy/tpm2"
)

func profile(t *testing.T, alg string) ekProfile {
	t.Helper()
	p, err := profileOf(alg)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

// The templates the client shipped with before EK discovery read NV, as
// marshaled TPMT_PUBLICs. The SRK, AK and LDevID ones decide which blobs load
// after an upgrade; the EK ones are what a TPM without NV templates uses.
var shippedTemplates = map[string]string{
	"srk":    "0023000b00030472000000060080004300100003001000000000",
	"ak":     "0023000b00050472000000100018000b0003001000000000",
	"ldevid": "0023000b00040472000000100018000b0003001000000000",
	"ecc":    "0023000b000300b20020837197674484b3f81a90cc8d46a5d724fd52d76e06520b64f2a1da1b331469aa0006008000430010000300100020000000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000",
	"rsa":    "0001000b000300b20020837197674484b3f81a90cc8d46a5d724fd52d76e06520b64f2a1da1b331469aa00060080004300100800000000000100" + strings.Repeat("00", 256),
}

func TestShippedTemplatesAreUnchanged(t *testing.T) {
	for name, got := range map[string]tpm2.Public{
		"srk": SRKTemplate, "ak": AKTemplate, "ldevid": LDevIDTemplate,
		"ecc": DefaultEKTemplateECC(), "rsa": DefaultEKTemplateRSA(),
	} {
		if hex.EncodeToString(encode(t, got)) != shippedTemplates[name] {
			t.Errorf("the %s template is not the one the client shipped", name)
		}
	}
}

func TestDefaultEKTemplatesAreFreshPerCall(t *testing.T) {
	a := DefaultEKTemplateRSA()
	a.RSAParameters.ModulusRaw[0] = 1
	a.AuthPolicy[0] = 1
	b := DefaultEKTemplateECC()
	b.ECCParameters.Point.XRaw[0] = 1
	if hex.EncodeToString(encode(t, DefaultEKTemplateRSA())) != shippedTemplates["rsa"] ||
		hex.EncodeToString(encode(t, DefaultEKTemplateECC())) != shippedTemplates["ecc"] {
		t.Fatal("changing one answer changed the default")
	}
}

func TestEKTemplateCalculation(t *testing.T) {
	rsaTemplate := DefaultEKTemplateRSA()
	rsaTemplate.RSAParameters.ModulusRaw = nil
	eccTemplate := DefaultEKTemplateECC()
	eccTemplate.ECCParameters.Point = tpm2.ECPoint{}
	eccTemplate.Attributes |= tpm2.FlagNoDA
	nonce := []byte("manufacturer nonce")

	padded := func(n int) []byte { return append(bytes.Clone(nonce), make([]byte, n-len(nonce))...) }
	wantRSA := DefaultEKTemplateRSA()
	wantRSA.RSAParameters.ModulusRaw = padded(256)
	wantECC := DefaultEKTemplateECC()
	wantECC.Attributes |= tpm2.FlagNoDA
	wantECC.ECCParameters.Point = tpm2.ECPoint{XRaw: padded(32), YRaw: make([]byte, 32)}

	for _, c := range []struct {
		name            string
		alg             string
		template, nonce []byte
		want            tpm2.Public
	}{
		{"RSA default", "rsa", nil, nil, DefaultEKTemplateRSA()},
		{"ECC default", "ecc", nil, nil, DefaultEKTemplateECC()},
		{"RSA template alone is used unmodified", "rsa", encode(t, rsaTemplate), nil, rsaTemplate},
		{"ECC template alone is used unmodified", "ecc", encode(t, eccTemplate), nil, eccTemplate},
		{"RSA nonce fills unique.rsa to 256 bytes", "rsa", encode(t, rsaTemplate), nonce, wantRSA},
		{"ECC nonce fills unique.x, y is 32 zeros", "ecc", encode(t, eccTemplate), nonce, wantECC},
	} {
		got, err := ekTemplate(profile(t, c.alg), c.template, c.nonce)
		if err != nil {
			t.Errorf("%s: %v", c.name, err)
			continue
		}
		if !bytes.Equal(encode(t, got), encode(t, c.want)) {
			t.Errorf("%s: got %x", c.name, encode(t, got))
		}
	}
}

func TestEKTemplateRefusals(t *testing.T) {
	rsa := func(f func(*tpm2.Public)) []byte {
		p := DefaultEKTemplateRSA()
		f(&p)
		return encode(t, p)
	}
	ecc := func(f func(*tpm2.Public)) []byte {
		p := DefaultEKTemplateECC()
		f(&p)
		return encode(t, p)
	}
	good := rsa(func(*tpm2.Public) {})
	for _, c := range []struct {
		name            string
		alg             string
		template, nonce []byte
		class           error
		index           uint32
	}{
		{"nonce without a template", "rsa", nil, []byte{1}, ErrUnsupportedEKProfile, 0x01c00003},
		{"oversized RSA nonce", "rsa", good, make([]byte, 257), ErrNVMalformed, 0x01c00003},
		{"oversized ECC nonce", "ecc", encode(t, DefaultEKTemplateECC()), make([]byte, 33), ErrNVMalformed, 0x01c0000b},
		{"truncated template", "rsa", good[:20], nil, ErrNVMalformed, 0x01c00004},
		{"trailing bytes", "rsa", append(bytes.Clone(good), 0), nil, ErrNVMalformed, 0x01c00004},
		{"RSA template at the ECC index", "ecc", good, nil, ErrNVMalformed, 0x01c0000c},
		{"RSA 3072", "rsa", rsa(func(p *tpm2.Public) { p.RSAParameters.KeyBits = 3072; p.RSAParameters.ModulusRaw = nil }), nil, ErrUnsupportedEKProfile, 0x01c00004},
		{"SHA-384 name", "rsa", rsa(func(p *tpm2.Public) { p.NameAlg = tpm2.AlgSHA384 }), nil, ErrUnsupportedEKProfile, 0x01c00004},
		{"another policy", "rsa", rsa(func(p *tpm2.Public) { p.AuthPolicy = make([]byte, 32) }), nil, ErrUnsupportedEKProfile, 0x01c00004},
		{"a signing key", "rsa", rsa(func(p *tpm2.Public) { p.Attributes |= tpm2.FlagSign }), nil, ErrUnsupportedEKProfile, 0x01c00004},
		{"reset on every boot", "ecc", ecc(func(p *tpm2.Public) { p.Attributes |= tpm2.FlagStClear }), nil, ErrUnsupportedEKProfile, 0x01c0000c},
		{"AES-256", "ecc", ecc(func(p *tpm2.Public) { p.ECCParameters.Symmetric.KeyBits = 256 }), nil, ErrUnsupportedEKProfile, 0x01c0000c},
		{"P-384", "ecc", ecc(func(p *tpm2.Public) {
			p.ECCParameters.CurveID = tpm2.CurveNISTP384
			p.ECCParameters.Point = tpm2.ECPoint{}
		}), nil, ErrUnsupportedEKProfile, 0x01c0000c},
	} {
		_, err := ekTemplate(profile(t, c.alg), c.template, c.nonce)
		var nv *NVError
		if !errors.Is(err, c.class) || !errors.As(err, &nv) || nv.Index != c.index {
			t.Errorf("%s: got %v, want %v at NV %#x", c.name, err, c.class, c.index)
		}
	}
}

func TestOnlyLowRangeRSAAndECCAreSupported(t *testing.T) {
	if _, err := profileOf("ecc-p384"); !errors.Is(err, ErrUnsupportedEKProfile) {
		t.Fatalf("got %v", err)
	}
	if len(ekProfiles) != 2 || ekProfiles[0].alg != "ecc" || ekProfiles[1].alg != "rsa" {
		t.Fatalf("profiles %+v", ekProfiles)
	}
}

func TestEKTemplateCalculationSharesNothing(t *testing.T) {
	p := profile(t, "rsa")
	raw := encode(t, DefaultEKTemplateRSA())
	want := hex.EncodeToString(encode(t, DefaultEKTemplateRSA()))
	var wg sync.WaitGroup
	for i := range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got, err := ekTemplate(p, raw, []byte{byte(i)})
			if err != nil {
				t.Error(err)
				return
			}
			if got.RSAParameters.ModulusRaw[0] != byte(i) {
				t.Errorf("template %d got another goroutine's nonce", i)
			}
			got.RSAParameters.ModulusRaw[1] = 0xff
		}()
	}
	wg.Wait()
	if hex.EncodeToString(raw) != want || hex.EncodeToString(encode(t, DefaultEKTemplateRSA())) != want {
		t.Fatal("a calculation changed its input or the default")
	}
}
