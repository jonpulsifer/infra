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

// Provenance holds the raw in-toto statement and claimed build level.
type Provenance struct {
	Statement    json.RawMessage `json:"statement"`
	ClaimedLevel int             `json:"claimedLevel"`
}

// Expectations describes the target expectations for verification.
type Expectations struct {
	Backend           string `json:"backend"`
	ExpectedBuilderID string `json:"expectedBuilderId"`
	MinimumLevel      int    `json:"minimumLevel"`
	MaximumLevel      int    `json:"maximumLevel"`
	SourceURI         string `json:"sourceUri"`
	BundleDigest      string `json:"bundleDigest"`
}

// VerificationResponse is the versioned JSON result returned by verification.
type VerificationResponse struct {
	Version    string                        `json:"version"`
	OK         bool                          `json:"ok"`
	Code       string                        `json:"code,omitempty"`
	Message    string                        `json:"message,omitempty"`
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
