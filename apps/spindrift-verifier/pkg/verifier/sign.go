package verifier

import (
	"encoding/json"
	"time"
)

// Sign generates a CoreSignature envelope for an admitted artifact.
func Sign(req SignRequest, now func() time.Time) SignResponse {
	if now == nil {
		now = time.Now
	}

	if req.Artifact.Digest == "" {
		return SignResponse{
			Version: "v1",
			OK:      false,
			Code:    "SIGNING_FAILED",
			Message: "artifact has no digest",
		}
	}
	if req.Key == "" {
		return SignResponse{
			Version: "v1",
			OK:      false,
			Code:    "SIGNING_FAILED",
			Message: "key is required for signing",
		}
	}

	bundle := json.RawMessage(`{"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json"}`)

	return SignResponse{
		Version: "v1",
		OK:      true,
		Signature: &CoreSignature{
			ArtifactDigest: req.Artifact.Digest,
			Signer:         req.Key,
			Format:         "cosign",
			Bundle:         bundle,
			SignedAt:       now().UTC().Format(time.RFC3339Nano),
		},
	}
}
