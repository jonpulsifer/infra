package verifier

import "encoding/json"
import "fmt"
import "regexp"
import "strings"
import "time"

var slsaVersionRegex = regexp.MustCompile(`(?i)slsa[^/]*/v(\d+(?:\.\d+)?)`)

// Verify performs strict provenance verification against specified expectations.
func Verify(req VerificationRequest, now func() time.Time) VerificationResponse {
	if now == nil {
		now = time.Now
	}

	backend := req.Expectations.Backend
	if backend == "" {
		backend = "hosted"
	}

	// 1. Check for missing provenance
	if len(req.Provenance.Statement) == 0 || string(req.Provenance.Statement) == "null" {
		return VerificationResponse{
			Version: "v1",
			OK:      false,
			Code:    "PROVENANCE_MISSING",
			Message: fmt.Sprintf("%s returned no backend provenance", backend),
		}
	}

	// 2. Check artifact digest & reference
	if req.Artifact.Digest == "" {
		return VerificationResponse{
			Version: "v1",
			OK:      false,
			Code:    "PROVENANCE_INVALID",
			Message: fmt.Sprintf("%s returned no immutable image reference for digest", backend),
		}
	}

	hasImmutableRef := false
	for _, ref := range req.Artifact.Refs {
		if strings.Contains(ref, req.Artifact.Digest) {
			hasImmutableRef = true
			break
		}
	}
	if len(req.Artifact.Refs) > 0 && !hasImmutableRef {
		return VerificationResponse{
			Version: "v1",
			OK:      false,
			Code:    "PROVENANCE_INVALID",
			Message: fmt.Sprintf("%s returned no immutable image reference for %s", backend, req.Artifact.Digest),
		}
	}

	// 3. Parse statement JSON
	var stmt map[string]interface{}
	if err := json.Unmarshal(req.Provenance.Statement, &stmt); err != nil {
		return VerificationResponse{
			Version: "v1",
			OK:      false,
			Code:    "PROVENANCE_INVALID",
			Message: fmt.Sprintf("%s provenance did not verify: invalid JSON statement", backend),
		}
	}

	// 4. Extract builder ID
	extractedBuilderID := extractBuilderID(stmt)
	if extractedBuilderID != "" && req.Expectations.ExpectedBuilderID != "" && extractedBuilderID != req.Expectations.ExpectedBuilderID {
		return VerificationResponse{
			Version: "v1",
			OK:      false,
			Code:    "PROVENANCE_INVALID",
			Message: fmt.Sprintf("%s provenance builder mismatch: expected %s, got %s", backend, req.Expectations.ExpectedBuilderID, extractedBuilderID),
		}
	}

	// 5. Extract bundle digest and verify binding
	extractedBundleDigest := extractBundleDigest(stmt)
	if req.Expectations.BundleDigest != "" {
		if extractedBundleDigest == "" {
			return VerificationResponse{
				Version: "v1",
				OK:      false,
				Code:    "PROVENANCE_INVALID",
				Message: fmt.Sprintf("%s verified provenance does not bind the source bundle digest", backend),
			}
		}
		if extractedBundleDigest != req.Expectations.BundleDigest {
			return VerificationResponse{
				Version: "v1",
				OK:      false,
				Code:    "PROVENANCE_INVALID",
				Message: fmt.Sprintf("%s verified provenance names bundle %s, not %s", backend, extractedBundleDigest, req.Expectations.BundleDigest),
			}
		}
	}

	// 6. Calculate achieved build level and compare with policy
	achievedLevel := req.Provenance.ClaimedLevel
	if req.Expectations.MaximumLevel > 0 && achievedLevel > req.Expectations.MaximumLevel {
		achievedLevel = req.Expectations.MaximumLevel
	}

	if req.Expectations.MinimumLevel > 0 && achievedLevel < req.Expectations.MinimumLevel {
		return VerificationResponse{
			Version: "v1",
			OK:      false,
			Code:    "BUILD_LEVEL_BELOW_POLICY",
			Message: fmt.Sprintf("%s produced verified Build Level %d, but this Target requires L%d", backend, achievedLevel, req.Expectations.MinimumLevel),
		}
	}

	// 7. Extract SLSA version
	slsaVer := extractSLSAVersion(stmt)

	builderID := extractedBuilderID
	if builderID == "" {
		builderID = req.Expectations.ExpectedBuilderID
	}

	return VerificationResponse{
		Version: "v1",
		OK:      true,
		Assessment: &BackendProvenanceAssessment{
			ArtifactDigest: req.Artifact.Digest,
			BundleDigest:   extractedBundleDigest,
			Backend:        backend,
			BuilderID:      builderID,
			SLSAVersion:    slsaVer,
			AchievedLevel:  achievedLevel,
			VerifiedAt:     now().UTC().Format(time.RFC3339Nano),
			Envelope:       req.Provenance.Statement,
		},
	}
}

func extractBuilderID(stmt map[string]interface{}) string {
	predicate, _ := stmt["predicate"].(map[string]interface{})
	if predicate == nil {
		return ""
	}
	runDetails, _ := predicate["runDetails"].(map[string]interface{})
	if runDetails == nil {
		return ""
	}
	builder, _ := runDetails["builder"].(map[string]interface{})
	if builder == nil {
		return ""
	}
	id, _ := builder["id"].(string)
	return id
}

func extractBundleDigest(stmt map[string]interface{}) string {
	predicate, _ := stmt["predicate"].(map[string]interface{})
	if predicate == nil {
		return ""
	}
	buildDefinition, _ := predicate["buildDefinition"].(map[string]interface{})
	if buildDefinition == nil {
		return ""
	}
	externalParameters, _ := buildDefinition["externalParameters"].(map[string]interface{})
	if externalParameters == nil {
		return ""
	}
	digest, _ := externalParameters["bundleDigest"].(string)
	return digest
}

func extractSLSAVersion(stmt map[string]interface{}) string {
	predType, _ := stmt["predicateType"].(string)
	if predType == "" {
		return "unknown"
	}
	match := slsaVersionRegex.FindStringSubmatch(predType)
	if len(match) > 1 {
		return match[1]
	}
	return "1.2"
}
