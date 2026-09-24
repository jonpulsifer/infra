# Cloud Run enforces the project's single Binary Authorization policy.
resource "google_binary_authorization_policy" "vessel" {
  project     = var.project
  description = "Require the trusted-builds provenance attestor for Spindrift runtimes"

  default_admission_rule {
    evaluation_mode         = "REQUIRE_ATTESTATION"
    enforcement_mode        = "ENFORCED_BLOCK_AND_AUDIT_LOG"
    require_attestations_by = [var.attestor]
  }

  global_policy_evaluation_mode = "ENABLE"

  depends_on = [google_project_service.service]
}

# Pins Cloud Run to the project policy so a deployer cannot opt a service out of verification.
resource "google_org_policy_policy" "require_binary_authorization" {
  name   = "projects/${var.project}/policies/run.allowedBinaryAuthorizationPolicies"
  parent = "projects/${var.project}"

  spec {
    inherit_from_parent = false
    rules {
      values {
        allowed_values = ["is:default"]
      }
    }
  }

  depends_on = [google_binary_authorization_policy.vessel]
}
