package verifier

import "encoding/json"

// VerificationRequest is the v1 input to Verify.
type VerificationRequest struct {
	Version      string       `json:"version"`
	Artifact     Artifact     `json:"artifact"`
	Provenance   Provenance   `json:"provenance"`
	Expectations Expectations `json:"expectations"`
}

type Artifact struct {
	Digest string   `json:"digest"`
	Refs   []string `json:"refs,omitempty"`
}

// Provenance holds an in-toto statement and the backend's base64 Ed25519 signature
// over its exact bytes, which Verify requires when BuilderPublicKey is set.
type Provenance struct {
	Statement    json.RawMessage `json:"statement"`
	Signature    string          `json:"signature,omitempty"`
	ClaimedLevel int             `json:"claimedLevel"`
}

type Expectations struct {
	Backend           string `json:"backend"`
	ExpectedBuilderID string `json:"expectedBuilderId"`
	// Base64 SPKI Ed25519 key. When set, a statement whose signature is absent or
	// does not verify against it is rejected.
	BuilderPublicKey string `json:"builderPublicKey,omitempty"`
	MinimumLevel     int    `json:"minimumLevel"`
	MaximumLevel     int    `json:"maximumLevel"`
	SourceURI        string `json:"sourceUri"`
	BundleDigest     string `json:"bundleDigest"`
}

// VerificationResponse is Verify's result. Code and Message are set only on failure.
type VerificationResponse struct {
	Version    string                       `json:"version"`
	OK         bool                         `json:"ok"`
	Code       string                       `json:"code,omitempty"`
	Message    string                       `json:"message,omitempty"`
	Assessment *BackendProvenanceAssessment `json:"assessment,omitempty"`
}

// BackendProvenanceAssessment contains normalized facts derived from verified provenance.
type BackendProvenanceAssessment struct {
	ArtifactDigest string          `json:"artifactDigest"`
	BundleDigest   string          `json:"bundleDigest"`
	Backend        string          `json:"backend"`
	BuilderID      string          `json:"builderId"`
	SLSAVersion    string          `json:"slsaVersion"`
	AchievedLevel  int             `json:"achievedLevel"`
	VerifiedAt     string          `json:"verifiedAt"`
	Envelope       json.RawMessage `json:"envelope"`
}

type SignRequest struct {
	Version  string   `json:"version"`
	Artifact Artifact `json:"artifact"`
	Key      string   `json:"key"` // PEM key file path or gcpkms:// reference
}

type SignResponse struct {
	Version   string         `json:"version"`
	OK        bool           `json:"ok"`
	Code      string         `json:"code,omitempty"`
	Message   string         `json:"message,omitempty"`
	Signature *CoreSignature `json:"signature,omitempty"`
}

// CoreSignature records a signature; Bundle is a SignatureBundle.
type CoreSignature struct {
	ArtifactDigest string          `json:"artifactDigest"`
	Signer         string          `json:"signer"`
	Format         string          `json:"format"`
	Bundle         json.RawMessage `json:"bundle"`
	SignedAt       string          `json:"signedAt"`
}
