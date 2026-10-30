package client

import (
	"bytes"
	"crypto/x509"
	"errors"
	"fmt"
	"io"

	"github.com/google/go-attestation/attest"
	"github.com/google/go-tpm/legacy/tpm2"
	direct "github.com/google/go-tpm/tpm2"
	"github.com/google/go-tpm/tpm2/transport"
	"github.com/google/go-tpm/tpmutil"
)

// EK discovery follows the TCG EK Credential Profile for TPM Family 2.0,
// Level 0, version 2.7: the NV index contents (2.2.2.2), the allowed EK
// Template and EK Nonce configurations (2.2.2.3), the Low Range (2.2.2.4),
// the High Range (2.2.2.5), the TPMT_PUBLIC calculation (2.2.2.6) and the
// default templates L-1 and L-2 (5.3).

// The classes of a failed EK discovery. Only an NV index that is not defined
// at all lets discovery go on with the profile's default, and that is no
// error.
var (
	// ErrNVPermission is an index the TPM will not let this client read.
	ErrNVPermission = errors.New("not readable")
	// ErrNVTransport is a read the TPM did not answer, or failed for a
	// reason that is neither absence nor permission.
	ErrNVTransport = errors.New("read failed")
	// ErrNVMalformed is an index whose contents are not what the profile
	// stores there.
	ErrNVMalformed = errors.New("malformed")
	// ErrUnsupportedEKProfile is a well-formed EK template or provisioning
	// this client cannot recreate and activate.
	ErrUnsupportedEKProfile = errors.New("unsupported EK profile")
	// ErrEKCertMismatch is a certificate that names another key than the EK
	// its template makes.
	ErrEKCertMismatch = errors.New("the EK certificate names another key")
)

// NVError is a failed read or check of one EK credential NV index.
type NVError struct {
	Index uint32
	Class error
	Err   error
}

func (e *NVError) Error() string {
	return fmt.Sprintf("NV %#x: %v: %v", e.Index, e.Class, e.Err)
}

func (e *NVError) Unwrap() []error { return []error{e.Class, e.Err} }

func nvFail(index uint32, class error, format string, args ...any) error {
	return &NVError{Index: index, Class: class, Err: fmt.Errorf(format, args...)}
}

// EK is an endorsement key as discovery resolved it.
type EK struct {
	// Alg is "rsa" or "ecc".
	Alg string
	// Template is the marshaled TPMT_PUBLIC that recreates the key. Every
	// use decodes it afresh, so nothing shares or mutates it.
	Template []byte
	// PublicDER is the key's SubjectPublicKeyInfo, and Hash its lowercase
	// hex SHA-256.
	PublicDER []byte
	Hash      string
	// Cert is the certificate's DER from NV, without trailing padding; nil
	// when its index is not defined.
	Cert []byte
	// TemplateNV and NonceNV are whether the manufacturer's EK Template and
	// EK Nonce shaped Template.
	TemplateNV, NonceNV bool
}

type ekProfile struct {
	alg, name             string
	typ                   tpm2.Algorithm
	cert, nonce, template uint32
	uniqueSize            int
	defaults              func() tpm2.Public
}

// The Low Range with the default templates L-1 and L-2, ECC first.
var ekProfiles = []ekProfile{
	{alg: "ecc", name: "ECC NIST P256", typ: tpm2.AlgECC, cert: 0x01c0000a, nonce: 0x01c0000b, template: 0x01c0000c, uniqueSize: 32, defaults: DefaultEKTemplateECC},
	{alg: "rsa", name: "RSA 2048", typ: tpm2.AlgRSA, cert: 0x01c00002, nonce: 0x01c00003, template: 0x01c00004, uniqueSize: 256, defaults: DefaultEKTemplateRSA},
}

func profileOf(alg string) (ekProfile, error) {
	for _, p := range ekProfiles {
		if p.alg == alg {
			return p, nil
		}
	}
	return ekProfile{}, fmt.Errorf("%w: %q; supported: RSA 2048 and ECC NIST P256 in the low range", ErrUnsupportedEKProfile, alg)
}

// DiscoverEKs finds the EKs an attestation sends: each whose certificate the
// TPM holds in the Low Range, ECC first, or the RSA EK alone when the TPM
// holds no certificate, which the inventory must then pin. A TPM that
// certifies its EKs in the High Range alone is an unsupported profile, not
// an uncertified one.
func DiscoverEKs(rw io.ReadWriter) ([]*EK, error) {
	var out []*EK
	for _, p := range ekProfiles {
		cert, err := readEKIndex(rw, p.cert)
		if err != nil {
			return nil, fmt.Errorf("%s EK certificate: %w", p.name, err)
		}
		if cert == nil && (len(out) > 0 || p.alg == "ecc") {
			continue
		}
		if cert == nil {
			high, err := HighRangeEKCerts(rw)
			if err != nil {
				return nil, err
			}
			if len(high) > 0 {
				return nil, fmt.Errorf("%w: the TPM holds EK certificates only in the High Range, at NV %#x", ErrUnsupportedEKProfile, high)
			}
		}
		e, err := discover(rw, p, cert)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, nil
}

// The handle range the registry reserves for EK credentials, the High
// Range's first certificate, and the EK certificate chain range inside it.
const (
	nvEKFirst        = 0x01c00000
	nvEKLast         = 0x01c07fff
	nvHighRangeFirst = 0x01c00012
	nvChainFirst     = 0x01c00100
	nvChainLast      = 0x01c001ff
)

// HighRangeEKCerts lists the defined NV indexes that hold an EK certificate
// in the High Range: the even ones from 0x01c00012, but the chain range.
func HighRangeEKCerts(rw io.ReadWriter) ([]uint32, error) {
	var out []uint32
	next := uint32(nvEKFirst)
	for {
		vals, more, err := tpm2.GetCapability(rw, tpm2.CapabilityHandles, 64, next)
		if err != nil {
			return nil, fmt.Errorf("list the EK credential NV indexes: %w: %w", ErrNVTransport, err)
		}
		for _, v := range vals {
			h, ok := v.(tpmutil.Handle)
			if !ok {
				continue
			}
			index := uint32(h)
			if index > nvEKLast {
				return out, nil
			}
			next = index + 1
			if index >= nvHighRangeFirst && index%2 == 0 && (index < nvChainFirst || index > nvChainLast) {
				out = append(out, index)
			}
		}
		if !more || len(vals) == 0 {
			return out, nil
		}
	}
}

// DiscoverEK resolves, creates and checks the EK of one profile, with or
// without a certificate.
func DiscoverEK(rw io.ReadWriter, alg string) (*EK, error) {
	p, err := profileOf(alg)
	if err != nil {
		return nil, err
	}
	cert, err := readEKIndex(rw, p.cert)
	if err != nil {
		return nil, fmt.Errorf("%s EK certificate: %w", p.name, err)
	}
	return discover(rw, p, cert)
}

func discover(rw io.ReadWriter, p ekProfile, cert []byte) (*EK, error) {
	rawTemplate, err := readEKIndex(rw, p.template)
	if err != nil {
		return nil, fmt.Errorf("%s EK template: %w", p.name, err)
	}
	nonce, err := readEKIndex(rw, p.nonce)
	if err != nil {
		return nil, fmt.Errorf("%s EK nonce: %w", p.name, err)
	}
	tmpl, err := ekTemplate(p, rawTemplate, nonce)
	if err != nil {
		return nil, fmt.Errorf("%s EK: %w", p.name, err)
	}
	raw, err := tmpl.Encode()
	if err != nil {
		return nil, err
	}
	e := &EK{Alg: p.alg, Template: raw, TemplateNV: rawTemplate != nil, NonceNV: nonce != nil}
	if e.PublicDER, err = createEK(rw, raw); err != nil {
		return nil, fmt.Errorf("create %s EK: %w", p.name, err)
	}
	e.Hash = hashHex(e.PublicDER)
	if cert == nil {
		return e, nil
	}
	e.Cert = trimDER(cert)
	c, err := attest.ParseEKCertificate(e.Cert)
	if err != nil {
		return nil, fmt.Errorf("%s EK certificate: %w", p.name, &NVError{Index: p.cert, Class: ErrNVMalformed, Err: err})
	}
	der, err := x509.MarshalPKIXPublicKey(c.PublicKey)
	if err != nil || !bytes.Equal(der, e.PublicDER) {
		return nil, fmt.Errorf("%s EK: %w: the certificate at NV %#x does not certify the EK %s that its template makes", p.name, ErrEKCertMismatch, p.cert, e.Hash)
	}
	return e, nil
}

// ekTemplate is the TPMT_PUBLIC calculation of 2.2.2.6: the default when
// the EK Template is absent, the EK Template unmodified when the EK Nonce is
// absent, else the EK Template with the nonce, padded with zeros, as its
// unique field. Each call answers a template of its own.
func ekTemplate(p ekProfile, rawTemplate, nonce []byte) (tpm2.Public, error) {
	if rawTemplate == nil {
		if nonce != nil {
			return tpm2.Public{}, nvFail(p.nonce, ErrUnsupportedEKProfile, "an EK Nonce without an EK Template, which the profile leaves unspecified and forbids")
		}
		return p.defaults(), nil
	}
	t, err := decodeEKTemplate(p, rawTemplate)
	if err != nil {
		return tpm2.Public{}, err
	}
	if nonce == nil {
		return t, nil
	}
	if len(nonce) > p.uniqueSize {
		return tpm2.Public{}, nvFail(p.nonce, ErrNVMalformed, "an EK Nonce of %d bytes, more than the %d of the unique field", len(nonce), p.uniqueSize)
	}
	unique := make([]byte, p.uniqueSize)
	copy(unique, nonce)
	if p.typ == tpm2.AlgRSA {
		t.RSAParameters.ModulusRaw = unique
	} else {
		t.ECCParameters.Point = tpm2.ECPoint{XRaw: unique, YRaw: make([]byte, p.uniqueSize)}
	}
	return t, nil
}

var symAES128CFB = tpm2.SymScheme{Alg: tpm2.AlgAES, KeyBits: 128, Mode: tpm2.AlgCFB}

// decodeEKTemplate parses an EK Template and refuses one this client cannot
// activate a credential with: the server wraps credentials for an AES-128
// CFB storage key named with SHA-256, and activation satisfies PolicyA
// alone (5.3.2).
func decodeEKTemplate(p ekProfile, raw []byte) (tpm2.Public, error) {
	t, err := tpm2.DecodePublic(raw)
	if err != nil {
		return tpm2.Public{}, nvFail(p.template, ErrNVMalformed, "EK Template: %v", err)
	}
	if again, err := t.Encode(); err != nil || !bytes.Equal(again, raw) {
		return tpm2.Public{}, nvFail(p.template, ErrNVMalformed, "EK Template is not one TPMT_PUBLIC")
	}
	if t.Type != p.typ {
		return tpm2.Public{}, nvFail(p.template, ErrNVMalformed, "EK Template of type %v at the %s index", t.Type, p.name)
	}
	unsupported := func(format string, args ...any) error {
		return nvFail(p.template, ErrUnsupportedEKProfile, "EK Template with "+format, args...)
	}
	switch {
	case t.NameAlg != tpm2.AlgSHA256:
		return tpm2.Public{}, unsupported("name algorithm %v", t.NameAlg)
	case t.Attributes&^(tpm2.FlagNoDA|tpm2.FlagUserWithAuth) != ekAttributes:
		return tpm2.Public{}, unsupported("attributes %#x", uint32(t.Attributes))
	case !bytes.Equal(t.AuthPolicy, ekPolicyA):
		return tpm2.Public{}, unsupported("an authorization policy other than PolicyA")
	}
	nullSign := func(s *tpm2.SigScheme) bool { return s == nil || s.Alg == tpm2.AlgNull }
	if p.typ == tpm2.AlgRSA {
		r := t.RSAParameters
		switch {
		case r.KeyBits != 2048:
			return tpm2.Public{}, unsupported("an RSA key of %d bits", r.KeyBits)
		case r.Symmetric == nil || *r.Symmetric != symAES128CFB:
			return tpm2.Public{}, unsupported("a symmetric scheme other than AES-128 CFB")
		case !nullSign(r.Sign):
			return tpm2.Public{}, unsupported("an RSA scheme")
		case r.ExponentRaw != 0 && r.ExponentRaw != 65537:
			return tpm2.Public{}, unsupported("exponent %d", r.ExponentRaw)
		case len(r.ModulusRaw) > p.uniqueSize:
			return tpm2.Public{}, nvFail(p.template, ErrNVMalformed, "EK Template unique field of %d bytes", len(r.ModulusRaw))
		}
		return t, nil
	}
	e := t.ECCParameters
	switch {
	case e.CurveID != tpm2.CurveNISTP256:
		return tpm2.Public{}, unsupported("curve %v", e.CurveID)
	case e.Symmetric == nil || *e.Symmetric != symAES128CFB:
		return tpm2.Public{}, unsupported("a symmetric scheme other than AES-128 CFB")
	case !nullSign(e.Sign):
		return tpm2.Public{}, unsupported("an ECC scheme")
	case e.KDF != nil && e.KDF.Alg != tpm2.AlgNull:
		return tpm2.Public{}, unsupported("a KDF")
	case len(e.Point.XRaw) > p.uniqueSize || len(e.Point.YRaw) > p.uniqueSize:
		return tpm2.Public{}, nvFail(p.template, ErrNVMalformed, "EK Template unique point of %d and %d bytes", len(e.Point.XRaw), len(e.Point.YRaw))
	}
	return t, nil
}

// createEK makes the EK from a marshaled template and answers its
// SubjectPublicKeyInfo. The key is transient and flushed.
func createEK(rw io.ReadWriter, template []byte) ([]byte, error) {
	t, err := tpm2.DecodePublic(template)
	if err != nil {
		return nil, err
	}
	h, pub, err := tpm2.CreatePrimary(rw, tpm2.HandleEndorsement, tpm2.PCRSelection{}, "", "", t)
	if err != nil {
		return nil, err
	}
	_ = tpm2.FlushContext(rw, h)
	return x509.MarshalPKIXPublicKey(pub)
}

// loadEK recreates the discovered EK for one use, and refuses a key that is
// not the one discovery sent.
func loadEK(rw io.ReadWriter, e *EK) (tpmutil.Handle, error) {
	t, err := tpm2.DecodePublic(e.Template)
	if err != nil {
		return 0, err
	}
	h, pub, err := tpm2.CreatePrimary(rw, tpm2.HandleEndorsement, tpm2.PCRSelection{}, "", "", t)
	if err != nil {
		return 0, fmt.Errorf("recreate EK: %w", err)
	}
	if der, err := x509.MarshalPKIXPublicKey(pub); err != nil || !bytes.Equal(der, e.PublicDER) {
		_ = tpm2.FlushContext(rw, h)
		return 0, fmt.Errorf("the recreated %s EK is not the one discovery found", e.Alg)
	}
	return h, nil
}

// readEKIndex reads one EK credential NV index whole. It answers nil and no
// error only when the index is not defined.
func readEKIndex(rw io.ReadWriter, index uint32) ([]byte, error) {
	tpm := transport.FromReadWriter(rw)
	h := direct.TPMHandle(index)
	rsp, pub, err := nvPublic(tpm, index)
	if err != nil || rsp == nil {
		return nil, err
	}
	switch {
	case !pub.Attributes.Written:
		return nil, nvFail(index, ErrNVMalformed, "defined but never written")
	case pub.DataSize == 0:
		return nil, nvFail(index, ErrNVMalformed, "defined with no data")
	}
	auth := direct.AuthHandle{Handle: direct.TPMRHOwner, Auth: direct.PasswordAuth(nil)}
	switch {
	case pub.Attributes.OwnerRead:
	case pub.Attributes.AuthRead:
		auth = direct.AuthHandle{Handle: h, Name: rsp.NVName, Auth: direct.PasswordAuth(nil)}
	default:
		return nil, nvFail(index, ErrNVPermission, "readable by neither the owner nor its own authorization")
	}
	out := make([]byte, 0, pub.DataSize)
	for len(out) < int(pub.DataSize) {
		n := min(nvChunk, int(pub.DataSize)-len(out))
		got, err := direct.NVRead{
			AuthHandle: auth,
			NVIndex:    direct.NamedHandle{Handle: h, Name: rsp.NVName},
			Size:       uint16(n),
			Offset:     uint16(len(out)),
		}.Execute(tpm)
		if err != nil {
			return nil, nvError(index, err)
		}
		if len(got.Data.Buffer) == 0 {
			return nil, nvFail(index, ErrNVTransport, "empty read at offset %d", len(out))
		}
		out = append(out, got.Data.Buffer...)
	}
	return out, nil
}

// nvPublic answers an index's public area, or nothing and no error when the
// index is not defined.
func nvPublic(tpm transport.TPM, index uint32) (*direct.NVReadPublicResponse, *direct.TPMSNVPublic, error) {
	rsp, err := direct.NVReadPublic{NVIndex: direct.TPMHandle(index)}.Execute(tpm)
	if errors.Is(err, direct.TPMRCHandle) {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, nvError(index, err)
	}
	pub, err := rsp.NVPublic.Contents()
	if err != nil {
		return nil, nil, &NVError{Index: index, Class: ErrNVMalformed, Err: err}
	}
	return rsp, pub, nil
}

var nvPermissionCodes = []direct.TPMRC{
	direct.TPMRCNVAuthorization, direct.TPMRCNVLocked, direct.TPMRCAuthUnavailable,
	direct.TPMRCAuthType, direct.TPMRCAuthMissing, direct.TPMRCBadAuth, direct.TPMRCAuthFail,
	direct.TPMRCPolicyFail, direct.TPMRCHierarchy, direct.TPMRCLockout,
}

func nvError(index uint32, err error) error {
	var rc direct.TPMRC
	if !errors.As(err, &rc) {
		return &NVError{Index: index, Class: ErrNVTransport, Err: err}
	}
	for _, code := range nvPermissionCodes {
		if errors.Is(rc, code) {
			return &NVError{Index: index, Class: ErrNVPermission, Err: err}
		}
	}
	if errors.Is(rc, direct.TPMRCNVUninitialized) {
		return &NVError{Index: index, Class: ErrNVMalformed, Err: err}
	}
	return &NVError{Index: index, Class: ErrNVTransport, Err: err}
}
