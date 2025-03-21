resource "google_organization_iam_custom_role" "read_only_vault" {
  role_id     = "readOnlyVault"
  org_id      = data.google_organization.org.org_id
  title       = "Hashicorp Vault Read Only"
  description = "Permissions that allow Vault to validate service account credentials and compute instance metadata"
  permissions = ["iam.serviceAccounts.get", "iam.serviceAccountKeys.get", "compute.instances.get", "compute.instanceGroups.list"]
}
