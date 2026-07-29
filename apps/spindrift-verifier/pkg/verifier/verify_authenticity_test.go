package verifier

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

// signedStatement returns the statement bytes, a base64 Ed25519 signature
// over those bytes, and the builder's base64 SPKI public key — the three
// things a real backend's provenance carries for cryptographic authenticity.
func signedStatement(t *testing.T, statement map[string]interface{}) (json.RawMessage, string, string) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	stmtBytes, _ := json.Marshal(statement)
	sig := ed25519.Sign(priv, stmtBytes)
	der, _ := x509.MarshalPKIXPublicKey(pub)
	return stmtBytes, base64.StdEncoding.EncodeToString(sig), base64.StdEncoding.EncodeToString(der)
}

func statementWithSubject(bundle, subject string) map[string]interface{} {
	return map[string]interface{}{
		"_type":         "https://in-toto.io/Statement/v1",
		"predicateType": "https://slsa.dev/provenance/v1",
		"subject": []map[string]interface{}{
			{"name": "image", "digest": map[string]string{"sha256": strings.TrimPrefix(subject, "sha256:")}},
		},
		"predicate": map[string]interface{}{
			"buildDefinition": map[string]interface{}{
				"externalParameters": map[string]string{"bundleDigest": bundle},
			},
			"runDetails": map[string]interface{}{
				"builder": map[string]string{"id": "https://github.com/actions/runner/github-hosted"},
			},
		},
	}
}

func TestVerify_SignedProvenanceAuthentic(t *testing.T) {
	stmt := statementWithSubject(testBundle, testDigest)
	stmtBytes, sig, pub := signedStatement(t, stmt)
	req := VerificationRequest{
		Artifact: Artifact{Digest: testDigest, Refs: []string{"r@" + testDigest}},
		Provenance: Provenance{
			Statement:    stmtBytes,
			ClaimedLevel: 2,
			Signature:    sig,
		},
		Expectations: Expectations{
			Backend:           "hosted",
			ExpectedBuilderID: "https://github.com/actions/runner/github-hosted",
			BuilderPublicKey:  pub,
			BundleDigest:      testBundle,
			MinimumLevel:      2,
			MaximumLevel:      2,
		},
	}
	resp := Verify(req, mockNow)
	if !resp.OK {
		t.Fatalf("expected OK for authentic signed provenance; got %s: %s", resp.Code, resp.Message)
	}
}

func TestVerify_TamperedProvenanceRejected(t *testing.T) {
	stmt := statementWithSubject(testBundle, testDigest)
	stmtBytes, sig, pub := signedStatement(t, stmt)

	// Mutate the statement after it was signed — the signature no longer
	// covers what is being admitted.
	var mutated map[string]interface{}
	if err := json.Unmarshal(stmtBytes, &mutated); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	pred := mutated["predicate"].(map[string]interface{})
	pred["runDetails"].(map[string]interface{})["builder"].(map[string]interface{})["id"] = "https://evil.example/runner"
	mutatedBytes, _ := json.Marshal(mutated)

	req := VerificationRequest{
		Artifact: Artifact{Digest: testDigest, Refs: []string{"r@" + testDigest}},
		Provenance: Provenance{
			Statement:    mutatedBytes,
			ClaimedLevel: 2,
			Signature:    sig,
		},
		Expectations: Expectations{
			Backend:           "hosted",
			ExpectedBuilderID: "https://github.com/actions/runner/github-hosted",
			BuilderPublicKey:  pub,
			BundleDigest:      testBundle,
		},
	}
	resp := Verify(req, mockNow)
	if resp.OK {
		t.Fatalf("tampered provenance was admitted; expected rejection")
	}
	if resp.Code != "PROVENANCE_INVALID" {
		t.Errorf("expected PROVENANCE_INVALID, got %s", resp.Code)
	}
}

func TestVerify_ProvenanceSignedByWrongKeyRejected(t *testing.T) {
	stmt := statementWithSubject(testBundle, testDigest)
	stmtBytes, sig, _ := signedStatement(t, stmt)
	// A different builder key is configured as the expected one; the
	// statement was signed by the first key, so authenticity fails.
	otherPub, _, _ := ed25519.GenerateKey(rand.Reader)
	otherDER, _ := x509.MarshalPKIXPublicKey(otherPub)

	req := VerificationRequest{
		Artifact: Artifact{Digest: testDigest, Refs: []string{"r@" + testDigest}},
		Provenance: Provenance{
			Statement:    stmtBytes,
			ClaimedLevel: 2,
			Signature:    sig,
		},
		Expectations: Expectations{
			Backend:           "hosted",
			ExpectedBuilderID: "https://github.com/actions/runner/github-hosted",
			BuilderPublicKey:  base64.StdEncoding.EncodeToString(otherDER),
			BundleDigest:      testBundle,
		},
	}
	resp := Verify(req, mockNow)
	if resp.OK {
		t.Fatalf("provenance signed by an unknown key was admitted; expected rejection")
	}
}

func TestVerify_WrongSubjectRejected(t *testing.T) {
	stmt := statementWithSubject(testBundle, "sha256:"+repeat('d', 64))
	stmtBytes, sig, pub := signedStatement(t, stmt)
	req := VerificationRequest{
		Artifact: Artifact{Digest: testDigest, Refs: []string{"r@" + testDigest}},
		Provenance: Provenance{
			Statement:    stmtBytes,
			ClaimedLevel: 2,
			Signature:    sig,
		},
		Expectations: Expectations{
			Backend:           "hosted",
			ExpectedBuilderID: "https://github.com/actions/runner/github-hosted",
			BuilderPublicKey:  pub,
			BundleDigest:      testBundle,
		},
	}
	resp := Verify(req, mockNow)
	if resp.OK {
		t.Fatalf("provenance naming a different subject was admitted; expected rejection")
	}
	if resp.Code != "PROVENANCE_INVALID" {
		t.Errorf("expected PROVENANCE_INVALID, got %s", resp.Code)
	}
}

func TestVerify_InflatedClaimedLevelCapped(t *testing.T) {
	stmt := statementWithSubject(testBundle, testDigest)
	stmtBytes, sig, pub := signedStatement(t, stmt)
	req := VerificationRequest{
		Artifact: Artifact{Digest: testDigest, Refs: []string{"r@" + testDigest}},
		Provenance: Provenance{
			Statement: stmtBytes,
			// The backend claims L3, but this route's profile only permits L2.
			ClaimedLevel: 3,
			Signature:    sig,
		},
		Expectations: Expectations{
			Backend:           "hosted",
			ExpectedBuilderID: "https://github.com/actions/runner/github-hosted",
			BuilderPublicKey:  pub,
			BundleDigest:      testBundle,
			MinimumLevel:      2,
			MaximumLevel:      2,
		},
	}
	resp := Verify(req, mockNow)
	if !resp.OK {
		t.Fatalf("expected OK; got %s: %s", resp.Code, resp.Message)
	}
	if resp.Assessment.AchievedLevel != 2 {
		t.Errorf("claimed L3 must be capped to the profile's maximum L2, got %d", resp.Assessment.AchievedLevel)
	}
}
