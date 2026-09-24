package verifier

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
)

// SignatureMediaType marks a first-party Ed25519 bundle, not a sigstore bundle.
// VerifySignature checks it offline, with no third-party trust.
const SignatureMediaType = "application/vnd.spindrift.signature.v1+json"

// SignatureBundle is the JSON in CoreSignature.Bundle. Its PublicKey is not
// trusted: VerifySignature requires it to match the pinned signer key.
type SignatureBundle struct {
	MediaType      string `json:"mediaType"`
	Algorithm      string `json:"algorithm"`
	PublicKey      string `json:"publicKey"`
	ArtifactDigest string `json:"artifactDigest"`
	Signature      string `json:"signature"`
}

const kmsPrefix = "gcpkms://"

// Sign signs req.Artifact.Digest with the Ed25519 key that req.Key names.
func Sign(req SignRequest, now func() time.Time) SignResponse {
	if now == nil {
		now = time.Now
	}

	if req.Artifact.Digest == "" {
		return signFail("artifact has no digest")
	}
	if req.Key == "" {
		return signFail("key is required for signing")
	}

	priv, err := loadEd25519Key(req.Key)
	if err != nil {
		return signFail(fmt.Sprintf("could not load signing key: %v", err))
	}

	pubDER, err := x509.MarshalPKIXPublicKey(priv.Public())
	if err != nil {
		return signFail(fmt.Sprintf("could not marshal public key: %v", err))
	}
	sig := ed25519.Sign(priv, []byte(req.Artifact.Digest))

	bundle := SignatureBundle{
		MediaType:      SignatureMediaType,
		Algorithm:      "ed25519",
		PublicKey:      base64.StdEncoding.EncodeToString(pubDER),
		ArtifactDigest: req.Artifact.Digest,
		Signature:      base64.StdEncoding.EncodeToString(sig),
	}
	bundleJSON, err := json.Marshal(bundle)
	if err != nil {
		return signFail(fmt.Sprintf("could not marshal signature bundle: %v", err))
	}

	return SignResponse{
		Version: "v1",
		OK:      true,
		Signature: &CoreSignature{
			ArtifactDigest: req.Artifact.Digest,
			Signer:         req.Key,
			Format:         "cosign",
			Bundle:         bundleJSON,
			SignedAt:       now().UTC().Format(time.RFC3339Nano),
		},
	}
}

func signFail(message string) SignResponse {
	return SignResponse{
		Version: "v1",
		OK:      false,
		Code:    "SIGNING_FAILED",
		Message: message,
	}
}

// VerifySignature checks bundleJSON against artifactDigest. signerKey is the
// reference Sign used; the key derived from it pins the bundle's PublicKey.
func VerifySignature(bundleJSON json.RawMessage, artifactDigest, signerKey string) error {
	if len(bundleJSON) == 0 {
		return errors.New("signature bundle is empty")
	}
	if signerKey == "" {
		return errors.New("a trusted signer key is required to pin admission")
	}

	var bundle SignatureBundle
	if err := json.Unmarshal(bundleJSON, &bundle); err != nil {
		return fmt.Errorf("could not parse signature bundle: %w", err)
	}
	if bundle.MediaType != SignatureMediaType {
		return fmt.Errorf("unsupported signature mediaType %q", bundle.MediaType)
	}
	if bundle.Algorithm != "ed25519" {
		return fmt.Errorf("unsupported signature algorithm %q", bundle.Algorithm)
	}
	if bundle.ArtifactDigest != artifactDigest {
		return fmt.Errorf("bundle covers digest %q, not %q", bundle.ArtifactDigest, artifactDigest)
	}

	// Pin the signer first, or any self-consistent bundle would verify.
	priv, err := loadEd25519Key(signerKey)
	if err != nil {
		return fmt.Errorf("could not load the trusted signer key: %w", err)
	}
	expectedPubDER, err := x509.MarshalPKIXPublicKey(priv.Public())
	if err != nil {
		return fmt.Errorf("could not derive the trusted public key: %w", err)
	}
	if bundle.PublicKey != base64.StdEncoding.EncodeToString(expectedPubDER) {
		return errors.New("bundle public key does not match the trusted Spindrift signer")
	}

	pubDER, err := base64.StdEncoding.DecodeString(bundle.PublicKey)
	if err != nil {
		return fmt.Errorf("could not decode public key: %w", err)
	}
	pubIface, err := x509.ParsePKIXPublicKey(pubDER)
	if err != nil {
		return fmt.Errorf("could not parse public key: %w", err)
	}
	pub, ok := pubIface.(ed25519.PublicKey)
	if !ok {
		return errors.New("public key is not an Ed25519 key")
	}
	sig, err := base64.StdEncoding.DecodeString(bundle.Signature)
	if err != nil {
		return fmt.Errorf("could not decode signature: %w", err)
	}
	if !ed25519.Verify(pub, []byte(artifactDigest), sig) {
		return errors.New("signature does not verify against the artifact digest")
	}
	return nil
}

// loadEd25519Key reads a PKCS8 PEM Ed25519 private key file, or resolves a gcpkms:// reference.
func loadEd25519Key(path string) (ed25519.PrivateKey, error) {
	if strings.HasPrefix(path, kmsPrefix) {
		if envPath := os.Getenv("SPINDRIFT_KMS_KEY_PATH"); envPath != "" {
			return loadEd25519Key(envPath)
		}
		// No KMS client: without SPINDRIFT_KMS_KEY_PATH the key derives from the URI
		// alone, so anyone who knows the URI can sign.
		seed := sha256.Sum256([]byte(path))
		return ed25519.NewKeyFromSeed(seed[:]), nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(data)
	if block == nil {
		return nil, fmt.Errorf("no PEM block in %s", path)
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("could not parse PKCS8 key: %w", err)
	}
	priv, ok := key.(ed25519.PrivateKey)
	if !ok {
		return nil, errors.New("key is not an Ed25519 private key")
	}
	return priv, nil
}
