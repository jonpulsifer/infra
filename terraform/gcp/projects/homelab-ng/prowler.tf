# The identity Prowler scans as. It holds no key: the offsite cluster projects a
# ServiceAccount token for its own OIDC issuer, the fml pool exchanges it at STS,
# and this account is impersonated for the duration. `iam.managed.disable
# ServiceAccountKeyCreation` is enforced org-wide and cannot be overridden below
# the org, so keyless is the only shape available here, not merely the preferred
# one.
#
# Its read roles are bound at the organization node, in
# terraform/gcp/organization/organization-iam.tf — that policy is authoritative,
# so the grant has to live in it rather than beside this resource.
resource "google_service_account" "prowler" {
  account_id   = "prowler-scanner"
  display_name = "Prowler Cloud Security Scanner"
  description  = "Read-only posture scanning across the organization, impersonated from the offsite cluster by workload identity federation"
}

# Scoped to the one KSA that runs Prowler, not to the pool: the provider's
# attribute condition only proves a token came from *some* ServiceAccount in the
# cluster, so the namespace and name are what make this grant specific.
resource "google_service_account_iam_member" "prowler_offsite_workload_identity" {
  service_account_id = google_service_account.prowler.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principal://iam.googleapis.com/${google_iam_workload_identity_pool.fml.name}/subject/offsite:system:serviceaccount:prowler:prowler"
}
