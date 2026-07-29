package verifier

import "encoding/json"

// VerificationRequest represents the v1 verification request payload.
type VerificationRequest struct {
	Version      string       `json:"version"`
	Artifact     Artifact     `json:"artifact"`
	Provenance   Provenance   `json:"provenance"`
	Expectations Expectations `json:"expectations"`
}

// Artifact describes the target artifact.
type Artifact struct {
	Digest string   `json:"digest"`
	Refs   []string `json:"refs,omitempty"`
}

// Provenance holds the raw in-toto statement, the backend's signature over
// that statement, and the claimed build level.
//
// Statement is the isolation claim being verified; Signature is the backend's
// Ed25519 signature over the exact statement bytes, proving the statement is
// authentic and untampered. A statement with no signature is accepted only by
// routes that configured no BuilderPublicKey — nobody claimed cryptographic
// authenticity, so none is checked.
type Provenance struct {
	Statement    json.RawMessage `json:"statement"`
	Signature    string          `json:"signature,omitempty"`
	ClaimedLevel int             `json:"claimedLevel"`
}

// Expectations describes the target expectations for verification.
type Expectations struct {
	Backend           string `json:"backend"`
	ExpectedBuilderID string `json:"expectedBuilderId"`
	// BuilderPublicKey, when set, is the base64 SPKI public key the backend's
	// provenance signature must verify against. A route that sets this rejects
	// any statement whose signature is absent or does not verify — the
	// cryptographic authenticity half of admission.
	BuilderPublicKey string `json:"builderPublicKey,omitempty"`
	MinimumLevel     int    `json:"minimumLevel"`
	MaximumLevel     int    `json:"maximumLevel"`
	SourceURI        string `json:"sourceUri"`
	BundleDigest     string `json:"bundleDigest"`
}

// VerificationResponse is the versioned JSON result returned by verification.
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

// SignRequest represents a request to produce a core signature for an admitted artifact.
type SignRequest struct {
	Version  string   `json:"version"`
	Artifact Artifact `json:"artifact"`
	Key      string   `json:"key"`
}

// SignResponse represents the JSON output from a signing request.
type SignResponse struct {
	Version   string         `json:"version"`
	OK        bool           `json:"ok"`
	Code      string         `json:"code,omitempty"`
	Message   string         `json:"message,omitempty"`
	Signature *CoreSignature `json:"signature,omitempty"`
}

// CoreSignature represents the KMS signature envelope.
type CoreSignature struct {
	ArtifactDigest string          `json:"artifactDigest"`
	Signer         string          `json:"signer"`
	Format         string          `json:"format"`
	Bundle         json.RawMessage `json:"bundle"`
	SignedAt       string          `json:"signedAt"`
}
