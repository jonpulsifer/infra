package verifier

import (
	"encoding/json"
	"testing"
	"time"
)

const testDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const testBundle = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

func mockNow() time.Time {
	return time.Date(2026, 7, 28, 22, 0, 0, 0, time.UTC)
}

func validStatement() json.RawMessage {
	return json.RawMessage(`{
		"_type": "https://in-toto.io/Statement/v1",
		"predicateType": "https://slsa.dev/provenance/v1",
		"predicate": {
			"buildDefinition": {
				"externalParameters": {
					"bundleDigest": "` + testBundle + `"
				}
			},
			"runDetails": {
				"builder": {
					"id": "https://github.com/actions/runner/github-hosted"
				}
			}
		}
	}`)
}

func TestVerify_Valid(t *testing.T) {
	req := VerificationRequest{
		Version: "v1",
		Artifact: Artifact{
			Digest: testDigest,
			Refs:   []string{"registry.example.test/apps/shop@" + testDigest},
		},
		Provenance: Provenance{
			Statement:    validStatement(),
			ClaimedLevel: 2,
		},
		Expectations: Expectations{
			Backend:           "hosted",
			ExpectedBuilderID: "https://github.com/actions/runner/github-hosted",
			MinimumLevel:      2,
			MaximumLevel:      2,
			BundleDigest:      testBundle,
		},
	}

	resp := Verify(req, mockNow)
	if !resp.OK {
		t.Fatalf("expected OK true, got false; message: %s", resp.Message)
	}
	if resp.Assessment == nil {
		t.Fatalf("expected non-nil assessment")
	}
	if resp.Assessment.ArtifactDigest != testDigest {
		t.Errorf("expected digest %s, got %s", testDigest, resp.Assessment.ArtifactDigest)
	}
	if resp.Assessment.BundleDigest != testBundle {
		t.Errorf("expected bundle %s, got %s", testBundle, resp.Assessment.BundleDigest)
	}
	if resp.Assessment.AchievedLevel != 2 {
		t.Errorf("expected level 2, got %d", resp.Assessment.AchievedLevel)
	}
}

func TestVerify_MissingProvenance(t *testing.T) {
	req := VerificationRequest{
		Version: "v1",
		Artifact: Artifact{
			Digest: testDigest,
			Refs:   []string{"registry.example.test/apps/shop@" + testDigest},
		},
		Provenance: Provenance{
			Statement: nil,
		},
		Expectations: Expectations{
			Backend: "hosted",
		},
	}

	resp := Verify(req, mockNow)
	if resp.OK {
		t.Fatalf("expected OK false for missing provenance")
	}
	if resp.Code != "PROVENANCE_MISSING" {
		t.Errorf("expected code PROVENANCE_MISSING, got %s", resp.Code)
	}
}

func TestVerify_BuilderMismatch(t *testing.T) {
	req := VerificationRequest{
		Version: "v1",
		Artifact: Artifact{
			Digest: testDigest,
			Refs:   []string{"registry.example.test/apps/shop@" + testDigest},
		},
		Provenance: Provenance{
			Statement:    validStatement(),
			ClaimedLevel: 2,
		},
		Expectations: Expectations{
			Backend:           "hosted",
			ExpectedBuilderID: "https://github.com/untrusted/runner",
			MinimumLevel:      1,
			BundleDigest:      testBundle,
		},
	}

	resp := Verify(req, mockNow)
	if resp.OK {
		t.Fatalf("expected OK false for builder mismatch")
	}
	if resp.Code != "PROVENANCE_INVALID" {
		t.Errorf("expected code PROVENANCE_INVALID, got %s", resp.Code)
	}
}

func statementBuiltBy(builderID string) json.RawMessage {
	return json.RawMessage(`{
		"_type": "https://in-toto.io/Statement/v1",
		"predicateType": "https://slsa.dev/provenance/v1",
		"predicate": {
			"buildDefinition": {
				"externalParameters": {
					"bundleDigest": "` + testBundle + `"
				}
			},
			"runDetails": {
				"builder": {
					"id": "` + builderID + `"
				}
			}
		}
	}`)
}

func TestVerify_BuilderIDAliases(t *testing.T) {
	const legacy = "https://spindrift.dev/builders/in-cluster"
	const current = "https://kthx.dev/builders/in-cluster"
	cases := []struct {
		name     string
		expected string
		got      string
		ok       bool
	}{
		{"current expected, current claimed", current, current, true},
		{"current expected, legacy claimed", current, legacy, true},
		{"legacy expected, current claimed", legacy, current, true},
		{"legacy expected, legacy claimed", legacy, legacy, true},
		{"current expected, foreign claimed", current, "https://github.com/actions/runner/github-hosted", false},
		{"foreign expected, legacy claimed", "https://github.com/actions/runner/github-hosted", legacy, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := VerificationRequest{
				Version: "v1",
				Artifact: Artifact{
					Digest: testDigest,
					Refs:   []string{"registry.example.test/apps/shop@" + testDigest},
				},
				Provenance: Provenance{
					Statement:    statementBuiltBy(tc.got),
					ClaimedLevel: 1,
				},
				Expectations: Expectations{
					Backend:           "in-cluster",
					ExpectedBuilderID: tc.expected,
					MinimumLevel:      1,
					BundleDigest:      testBundle,
				},
			}

			resp := Verify(req, mockNow)
			if resp.OK != tc.ok {
				t.Fatalf("expected OK %v, got %v; message: %s", tc.ok, resp.OK, resp.Message)
			}
			if tc.ok && resp.Assessment.BuilderID != tc.got {
				t.Errorf("expected the assessment to record the claimed builder %s, got %s", tc.got, resp.Assessment.BuilderID)
			}
		})
	}
}

func TestVerify_BundleDigestMismatch(t *testing.T) {
	req := VerificationRequest{
		Version: "v1",
		Artifact: Artifact{
			Digest: testDigest,
			Refs:   []string{"registry.example.test/apps/shop@" + testDigest},
		},
		Provenance: Provenance{
			Statement:    validStatement(),
			ClaimedLevel: 2,
		},
		Expectations: Expectations{
			Backend:           "hosted",
			ExpectedBuilderID: "https://github.com/actions/runner/github-hosted",
			MinimumLevel:      1,
			BundleDigest:      "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
		},
	}

	resp := Verify(req, mockNow)
	if resp.OK {
		t.Fatalf("expected OK false for bundle mismatch")
	}
	if resp.Code != "PROVENANCE_INVALID" {
		t.Errorf("expected code PROVENANCE_INVALID, got %s", resp.Code)
	}
}

func TestVerify_LevelBelowPolicy(t *testing.T) {
	req := VerificationRequest{
		Version: "v1",
		Artifact: Artifact{
			Digest: testDigest,
			Refs:   []string{"registry.example.test/apps/shop@" + testDigest},
		},
		Provenance: Provenance{
			Statement:    validStatement(),
			ClaimedLevel: 1,
		},
		Expectations: Expectations{
			Backend:           "hosted",
			ExpectedBuilderID: "https://github.com/actions/runner/github-hosted",
			MinimumLevel:      3,
			MaximumLevel:      3,
			BundleDigest:      testBundle,
		},
	}

	resp := Verify(req, mockNow)
	if resp.OK {
		t.Fatalf("expected OK false for build level below policy")
	}
	if resp.Code != "BUILD_LEVEL_BELOW_POLICY" {
		t.Errorf("expected code BUILD_LEVEL_BELOW_POLICY, got %s", resp.Code)
	}
}

func TestSign_Valid(t *testing.T) {
	keyPath := writeEd25519Key(t)
	req := SignRequest{
		Version: "v1",
		Artifact: Artifact{
			Digest: testDigest,
		},
		Key: keyPath,
	}

	resp := Sign(req, mockNow)
	if !resp.OK {
		t.Fatalf("expected OK true for sign, got false: %s", resp.Message)
	}
	if resp.Signature == nil {
		t.Fatalf("expected non-nil signature")
	}
	if resp.Signature.ArtifactDigest != testDigest {
		t.Errorf("expected digest %s, got %s", testDigest, resp.Signature.ArtifactDigest)
	}
}
