# Binary Authorization and its org-policy pin live in the spindrift-vessel
# module (vessel.tf) — every vessel gets them. The two overrides below are
# deliberately NOT in the module: each is a documented exception whose cost is
# argued per project, and a module default would stamp the exception wherever
# the module goes.

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

# The second half of the same grant, and it fails separately.
#
# `iam.allowedPolicyMemberDomains` (organization/baseline-policies.tf) permits
# only principals belonging to this organization's Cloud Identity customer.
# `allUsers` belongs to no customer, so the same binding is refused a second
# time with a different sentence:
#
#   the invoker policy for {reach: public, auth: none} could not be written:
#   One or more users named in the policy do not belong to a permitted
#   customer, perhaps due to an organization policy.
#
# Every enforced constraint is an independent AND'd check, so relaxing the
# managed constraint above does nothing for this one — both have to give
# before a public Component can answer the internet.
#
# `allow_all` is broader than the grant needs: it permits any domain in this
# project, not merely the public principal. The constraint's list form takes
# customer IDs, and `allUsers` is not one, so there is no value that names it
# — the same shape of dead end as the managed constraint above. This follows
# the project-level override already used for the same constraint in
# `terraform/gcp/projects/lolcorp/policy.tf` and `homelab-ng/policy.tf`; the
# org default stays strict everywhere else.
#
# Removing this: the same two exits as above — Cloud Run's
# `invoker_iam_disabled` on public Services would retire the `allUsers`
# binding entirely, and with it both of these overrides.
resource "google_org_policy_policy" "allow_public_cloud_run_domains" {
  name   = "projects/${local.project}/policies/iam.allowedPolicyMemberDomains"
  parent = "projects/${local.project}"

  spec {
    inherit_from_parent = false
    rules {
      allow_all = "TRUE"
    }
  }
}
