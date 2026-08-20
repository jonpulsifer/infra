package main

import (
	"bytes"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// jwk field order is the wire order; kube-apiserver does not care, but keeping
// it stable keeps the committed documents diffable.
type jwk struct {
	Use string `json:"use"`
	Kty string `json:"kty"`
	Kid string `json:"kid"`
	Alg string `json:"alg"`
	N   string `json:"n"`
	E   string `json:"e"`
}

type jwksDoc struct {
	Keys []jwk `json:"keys"`
}

type discoveryDoc struct {
	Issuer                           string   `json:"issuer"`
	JwksURI                          string   `json:"jwks_uri"`
	ResponseTypesSupported           []string `json:"response_types_supported"`
	SubjectTypesSupported            []string `json:"subject_types_supported"`
	IDTokenSigningAlgValuesSupported []string `json:"id_token_signing_alg_values_supported"`
}

func b64url(b []byte) string {
	return base64.RawURLEncoding.EncodeToString(b)
}

func jwkFromCert(path string) (jwk, error) {
	cert, err := readCert(path)
	if err != nil {
		return jwk{}, err
	}
	pub, ok := cert.PublicKey.(*rsa.PublicKey)
	if !ok {
		return jwk{}, fmt.Errorf("%s: signer key is %s, JWKS needs RSA", path, keyAlgorithm(cert.PublicKey))
	}
	// kid must equal base64url(SHA256(DER SPKI)) — the derivation in
	// k8s.io/kubernetes pkg/serviceaccount keyIDFromPublicKey — or tokens the
	// apiserver mints will not resolve against these documents.
	sum, err := spkiSHA256(pub)
	if err != nil {
		return jwk{}, err
	}
	e := exponentBytes(pub.E)
	return jwk{
		Use: "sig",
		Kty: "RSA",
		Kid: b64url(sum[:]),
		Alg: "RS256",
		N:   b64url(pub.N.Bytes()),
		E:   b64url(e),
	}, nil
}

// exponentBytes renders a public exponent as the shortest big-endian byte string, which
// is what RFC 7518 asks for.
func exponentBytes(e int) []byte {
	var b []byte
	for v := e; v > 0; v >>= 8 {
		b = append([]byte{byte(v & 0xff)}, b...)
	}
	if len(b) == 0 {
		b = []byte{0}
	}
	return b
}

// writeJSON matches python's json.dumps(indent=2) plus a trailing newline, and
// leaves HTML characters alone so issuer URLs survive intact.
func writeJSON(path string, v any) error {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		return err
	}
	return os.WriteFile(path, buf.Bytes(), 0o644)
}

func runJWKS(issuer, outDir string, certs []string, errOut io.Writer) error {
	issuer = strings.TrimRight(issuer, "/")
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return err
	}
	doc := jwksDoc{}
	var kids []string
	for _, c := range certs {
		k, err := jwkFromCert(c)
		if err != nil {
			return err
		}
		doc.Keys = append(doc.Keys, k)
		kids = append(kids, k.Kid)
	}
	if err := writeJSON(filepath.Join(outDir, "jwks.json"), doc); err != nil {
		return err
	}
	discovery := discoveryDoc{
		Issuer:                           issuer,
		JwksURI:                          issuer + "/openid/v1/jwks",
		ResponseTypesSupported:           []string{"id_token"},
		SubjectTypesSupported:            []string{"public"},
		IDTokenSigningAlgValuesSupported: []string{"RS256"},
	}
	if err := writeJSON(filepath.Join(outDir, "openid-configuration.json"), discovery); err != nil {
		return err
	}
	fmt.Fprintf(errOut, "%s: %d key(s) [%s] for %s\n", outDir, len(doc.Keys), strings.Join(kids, ", "), issuer)
	return nil
}
