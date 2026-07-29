package verifier

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeEd25519Key writes a PKCS8 PEM Ed25519 private key to a temp file and
// returns its path. The signer reads the same encoding in production.
func writeEd25519Key(t *testing.T) string {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	_ = pub
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		t.Fatalf("marshal pkcs8: %v", err)
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "signer.pem")
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{
		Type:  "PRIVATE KEY",
		Bytes: der,
	}), 0o600); err != nil {
		t.Fatalf("write key: %v", err)
	}
	return path
}

func TestSign_RealEd25519ProducesVerifiableBundle(t *testing.T) {
	keyPath := writeEd25519Key(t)
	req := SignRequest{
		Version: "v1",
		Artifact: Artifact{
			Digest: testDigest,
			Refs:   []string{"registry.example.test/apps/shop@" + testDigest},
		},
		Key: keyPath,
	}

	resp := Sign(req, mockNow)
	if !resp.OK {
		t.Fatalf("expected OK true, got false: %s", resp.Message)
	}
	if resp.Signature == nil {
		t.Fatalf("expected non-nil signature")
	}
	if resp.Signature.ArtifactDigest != testDigest {
		t.Errorf("expected digest %s, got %s", testDigest, resp.Signature.ArtifactDigest)
	}
	if resp.Signature.Format != "cosign" {
		t.Errorf("expected envelope format cosign, got %s", resp.Signature.Format)
	}

	var bundle SignatureBundle
	if err := json.Unmarshal(resp.Signature.Bundle, &bundle); err != nil {
		t.Fatalf("bundle is not valid JSON: %v", err)
	}
	if bundle.Algorithm != "ed25519" {
		t.Errorf("expected algorithm ed25519, got %s", bundle.Algorithm)
	}
	if bundle.ArtifactDigest != testDigest {
		t.Errorf("bundle artifact digest mismatch: %s", bundle.ArtifactDigest)
	}
	if bundle.PublicKey == "" {
		t.Errorf("expected embedded public key")
	}
	if bundle.Signature == "" {
		t.Errorf("expected a real signature, not a placeholder")
	}
	if bundle.MediaType == "application/vnd.dev.sigstore.bundle.v0.3+json" {
		t.Errorf("the placeholder mediaType must not survive a real signature")
	}

	// The signature must be a 64-byte Ed25519 signature.
	sig, err := base64.StdEncoding.DecodeString(bundle.Signature)
	if err != nil {
		t.Fatalf("signature is not base64: %v", err)
	}
	if len(sig) != ed25519.SignatureSize {
		t.Fatalf("expected %d-byte signature, got %d", ed25519.SignatureSize, len(sig))
	}
}

func TestSign_BundleIsIndependentlyVerifiable(t *testing.T) {
	keyPath := writeEd25519Key(t)
	resp := Sign(SignRequest{
		Artifact: Artifact{Digest: testDigest},
		Key:      keyPath,
	}, mockNow)
	if !resp.OK {
		t.Fatalf("sign: %s", resp.Message)
	}

	if err := VerifySignature(resp.Signature.Bundle, testDigest, keyPath); err != nil {
		t.Fatalf("independent verification of a successful signature failed: %v", err)
	}
}

func TestSign_TamperedSignatureFailsVerification(t *testing.T) {
	keyPath := writeEd25519Key(t)
	resp := Sign(SignRequest{
		Artifact: Artifact{Digest: testDigest},
		Key:      keyPath,
	}, mockNow)
	if !resp.OK {
		t.Fatalf("sign: %s", resp.Message)
	}

	var bundle SignatureBundle
	if err := json.Unmarshal(resp.Signature.Bundle, &bundle); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	sig, _ := base64.StdEncoding.DecodeString(bundle.Signature)
	sig[0] ^= 0xff
	bundle.Signature = base64.StdEncoding.EncodeToString(sig)
	tampered, _ := json.Marshal(bundle)

	if err := VerifySignature(tampered, testDigest, keyPath); err == nil {
		t.Fatalf("a tampered signature verified; expected failure")
	}
}

func TestSign_WrongDigestFailsVerification(t *testing.T) {
	keyPath := writeEd25519Key(t)
	resp := Sign(SignRequest{
		Artifact: Artifact{Digest: testDigest},
		Key:      keyPath,
	}, mockNow)
	if !resp.OK {
		t.Fatalf("sign: %s", resp.Message)
	}

	if err := VerifySignature(resp.Signature.Bundle, "sha256:"+repeat('c', 64), keyPath); err == nil {
		t.Fatalf("verification against a different digest succeeded; expected failure")
	}
}

func TestSign_BundleFromAnotherSignerIsRefusedAtAdmission(t *testing.T) {
	// A bundle signed by a different key. It is internally self-consistent
	// — the signature verifies under its own public key — but admission
	// refuses because the public key is not Spindrift's trusted signer.
	otherKey := writeEd25519Key(t)
	trustedKey := writeEd25519Key(t)
	resp := Sign(SignRequest{
		Artifact: Artifact{Digest: testDigest},
		Key:      otherKey,
	}, mockNow)
	if !resp.OK {
		t.Fatalf("sign: %s", resp.Message)
	}

	err := VerifySignature(resp.Signature.Bundle, testDigest, trustedKey)
	if err == nil {
		t.Fatalf("a bundle signed by another key was admitted; expected refusal")
	}
	if !strings.Contains(err.Error(), "does not match the trusted Spindrift signer") {
		t.Errorf("expected a signer-mismatch refusal, got: %v", err)
	}
}

func TestSign_KMSKeyRefused(t *testing.T) {
	resp := Sign(SignRequest{
		Artifact: Artifact{Digest: testDigest},
		Key:      "gcpkms://projects/example/locations/global/keyRings/keys/signer",
	}, mockNow)
	if resp.OK {
		t.Fatalf("KMS signer was accepted; expected loud refusal")
	}
	if resp.Code != "SIGNING_FAILED" {
		t.Errorf("expected SIGNING_FAILED, got %s", resp.Code)
	}
	if !strings.Contains(resp.Message, "KMS signer") {
		t.Errorf("expected a KMS-specific message, got: %s", resp.Message)
	}
}

func TestVerifySignature_KMSKeyRefused(t *testing.T) {
	keyPath := writeEd25519Key(t)
	resp := Sign(SignRequest{
		Artifact: Artifact{Digest: testDigest},
		Key:      keyPath,
	}, mockNow)
	if !resp.OK {
		t.Fatalf("sign: %s", resp.Message)
	}
	err := VerifySignature(resp.Signature.Bundle, testDigest, "gcpkms://projects/example/keys/signer")
	if err == nil {
		t.Fatalf("KMS verifier was accepted; expected loud refusal")
	}
}

func TestSign_MissingKeyFileFails(t *testing.T) {
	resp := Sign(SignRequest{
		Artifact: Artifact{Digest: testDigest},
		Key:      "/nonexistent/path/signer.pem",
	}, mockNow)
	if resp.OK {
		t.Fatalf("expected OK false for a missing key file")
	}
	if resp.Code != "SIGNING_FAILED" {
		t.Errorf("expected code SIGNING_FAILED, got %s", resp.Code)
	}
}

func TestSign_MissingDigestFails(t *testing.T) {
	keyPath := writeEd25519Key(t)
	resp := Sign(SignRequest{
		Artifact: Artifact{},
		Key:      keyPath,
	}, mockNow)
	if resp.OK {
		t.Fatalf("expected OK false for missing digest")
	}
	if resp.Code != "SIGNING_FAILED" {
		t.Errorf("expected code SIGNING_FAILED, got %s", resp.Code)
	}
}

func TestVerifySignature_PlaceholderBundleRejected(t *testing.T) {
	keyPath := writeEd25519Key(t)
	placeholder, _ := json.Marshal(SignatureBundle{
		MediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
	})
	if err := VerifySignature(placeholder, testDigest, keyPath); err == nil {
		t.Fatalf("a mediaType-only placeholder verified; expected failure")
	}
}

func repeat(b byte, n int) string {
	out := make([]byte, n)
	for i := range out {
		out[i] = b
	}
	return string(out)
}
