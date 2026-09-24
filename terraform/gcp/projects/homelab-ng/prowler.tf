# Keyless: impersonated with the offsite cluster's projected token through the fml pool.
# Its read roles are in the authoritative terraform/gcp/organization/organization-iam.tf.
resource "google_service_account" "prowler" {
  account_id   = "prowler-scanner"
  display_name = "Prowler Cloud Security Scanner"
  description  = "Read-only posture scanning across the organization, impersonated from the offsite cluster by workload identity federation"
}

# The provider admits any ServiceAccount in the cluster, so this names Prowler's KSA.
resource "google_service_account_iam_member" "prowler_offsite_workload_identity" {
  service_account_id = google_service_account.prowler.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principal://iam.googleapis.com/${google_iam_workload_identity_pool.fml.name}/subject/offsite:system:serviceaccount:prowler:prowler"
}
