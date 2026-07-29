package verifier

import (
	"crypto/ed25519"
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

// SignatureMediaType is the envelope content type Spindrift's own signature
// carries. It is not the sigstore bundle mediaType — until a KMS-backed signer
// is wired, the bundle is a reviewable Ed25519 statement the platform's own
// verifier can re-check with no network and no third-party trust.
const SignatureMediaType = "application/vnd.spindrift.signature.v1+json"

// SignatureBundle is the verifiable payload of a CoreSignature.
//
// Every field a verifier needs is embedded: the public key, the algorithm, the
// artifact digest the signature covers, and the signature itself. A bundle
// that carries only a mediaType is a placeholder and is rejected by
// VerifySignature.
//
// The public key inside the bundle is **not trusted on its own**. Admission
// pins Spindrift's signing key by passing the same key reference to
// VerifySignature that Sign used; the bundle's public key must match the one
// derived from that reference before the signature is even looked at. Without
// this pinning the bundle would verify against any key an attacker chose.
type SignatureBundle struct {
	MediaType      string `json:"mediaType"`
	Algorithm      string `json:"algorithm"`
	PublicKey      string `json:"publicKey"`
	ArtifactDigest string `json:"artifactDigest"`
	Signature      string `json:"signature"`
}

// kmsPrefix marks a KMS URI signer reference. The reviewable offline path uses
// an Ed25519 private key file; a KMS-backed signer is the production target but
// is not wired yet. Both Sign and VerifySignature refuse this prefix loudly
// rather than silently degrading — "cryptographically real" means the signature
// means something, and a placeholder key is the opposite.
const kmsPrefix = "gcpkms://"

// Sign generates a real Ed25519 CoreSignature envelope for an admitted
// artifact.
//
// The configured signer is, for the reviewable offline path, an Ed25519
// private key read from the file named by req.Key. A KMS URI is refused loudly
// rather than silently producing a placeholder — the whole point of
// cryptographically real admission is that the signature means something.
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
	if strings.HasPrefix(req.Key, kmsPrefix) {
		return signFail(fmt.Sprintf(
			"KMS signer %q is configured but not wired; the reviewable offline path reads an Ed25519 private key file",
			req.Key,
		))
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

// VerifySignature independently verifies a CoreSignature bundle against the
// artifact digest it is supposed to cover, pinned to a trusted signer key.
//
// signerKey is the same reference Sign used — a path to an Ed25519 private key
// file. The verifier derives the expected public key from it and requires the
// bundle's embedded public key to match before the signature is checked, so a
// bundle signed by any other key fails even though it is internally
// self-consistent. This is the half of "cryptographically real" the previous
// placeholder lacked: admission proves *Spindrift's* key signed the digest, not
// *some* key.
//
// A KMS URI is refused with the same message Sign returns, so the two sides
// fail symmetrically until KMS is wired.
func VerifySignature(bundleJSON json.RawMessage, artifactDigest, signerKey string) error {
	if len(bundleJSON) == 0 {
		return errors.New("signature bundle is empty")
	}
	if signerKey == "" {
		return errors.New("a trusted signer key is required to pin admission")
	}
	if strings.HasPrefix(signerKey, kmsPrefix) {
		return fmt.Errorf(
			"KMS signer %q is configured but verification is not wired; the reviewable offline path reads an Ed25519 private key file",
			signerKey,
		)
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

	// Pin the signer: the public key in the bundle must be the one derived
	// from the trusted signer key file, or admission refuses. Without this
	// check any Ed25519 key the attacker chose would verify.
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

// loadEd25519Key reads a PKCS8 PEM Ed25519 private key from a file path.
func loadEd25519Key(path string) (ed25519.PrivateKey, error) {
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
