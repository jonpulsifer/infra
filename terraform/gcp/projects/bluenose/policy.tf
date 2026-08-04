# Cloud Run uses the project-singleton Binary Authorization policy. Every
# container deployment must carry an attestation verified by the shared
# trusted-builds authority.
resource "google_binary_authorization_policy" "spindrift" {
  project     = local.project
  description = "Require the trusted-builds provenance attestor for Spindrift runtimes"

  default_admission_rule {
    evaluation_mode         = "REQUIRE_ATTESTATION"
    enforcement_mode        = "ENFORCED_BLOCK_AND_AUDIT_LOG"
    require_attestations_by = ["projects/trusted-builds/attestors/provenance"]
  }

  global_policy_evaluation_mode = "ENABLE"

  depends_on = [
    google_project_service.service["binaryauthorization.googleapis.com"],
  ]
}

# Restrict Cloud Run to the enforcing project policy so a deployer cannot
# opt a service out of verification.
resource "google_org_policy_policy" "require_cloud_run_binary_authorization" {
  name   = "projects/${local.project}/policies/run.allowedBinaryAuthorizationPolicies"
  parent = "projects/${local.project}"

  spec {
    inherit_from_parent = false
    rules {
      values {
        allowed_values = ["is:default"]
      }
    }
  }

  depends_on = [google_binary_authorization_policy.spindrift]
}

# The org's iam.managed.allowedPolicyMembers (organization/baseline-policies.tf)
# only ever grants roles to the org's own principal set. Spindrift's `{reach:
# public, auth: none}` Cloud Run Components bind `roles/run.invoker` to
# `allUsers` (apps/spindrift/src/adapters/deploy/cloudrun/service.ts) so that
# is exactly the grant the org policy blocks, and there is no narrower fix
# available inside the constraint itself: `allowedMemberSubjects` requires
# every entry to contain a `:` (`user:...`, `serviceAccount:...`), so the
# bare special principal `allUsers` cannot be listed there at any parent —
# org, folder, or project — and `allowedPrincipalSets` only accepts
# organization principal sets. Google's own domain-restricted-sharing docs
# say allowing `allUsers`/`allAuthenticatedUsers` is only possible through a
# hand-authored custom constraint, and a custom constraint cannot carve an
# exception out of a *different*, already-enforced constraint — every
# enforced constraint on a resource is a separate AND'd check, none of them
# "wins" over another. The only lever this constraint exposes is turning its
# own enforcement off for a scope, so that is what this does, at the
# narrowest scope that covers Spindrift's runtime project and nothing wider.
#
# What this actually costs: everything under this project — not just Cloud
# Run's invoker binding — loses domain-restricted sharing. A binding minted
# anywhere in bluenose (a bucket ACL, a service account grant) could in
# principle name a principal outside the org and the org policy would no
# longer be the backstop that catches it; Binary Authorization and the
# controller's own role grants (iam.tf) are what keep that theoretical from
# being reachable in practice. bluenose is single-purpose (Spindrift's Cloud
# Run vessel, see README.md) so there is nothing else in this project for a
# stray grant to reach.
#
# Removing this: either GCP extends the managed constraint to accept
# `allUsers` (or the org adopts the legacy iam.allowedPolicyMemberDomains
# constraint's allUsers exception instead), or Spindrift stops needing an
# `allUsers` IAM binding at all by setting Cloud Run's own
# `invoker_iam_disabled` field on public Services — which the
# run.managed.requireInvokerIam managed constraint (unset here, org default
# ALLOW) already permits — instead of granting `roles/run.invoker`.
resource "google_org_policy_policy" "allow_public_cloud_run_invoker" {
  name   = "projects/${local.project}/policies/iam.managed.allowedPolicyMembers"
  parent = "projects/${local.project}"

  spec {
    inherit_from_parent = false
    rules {
      enforce = "FALSE"
    }
  }
}
