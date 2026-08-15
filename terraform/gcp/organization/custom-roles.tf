resource "google_organization_iam_custom_role" "read_only_vault" {
  role_id     = "readOnlyVault"
  org_id      = data.google_organization.org.org_id
  title       = "Hashicorp Vault Read Only"
  description = "Permissions that allow Vault to validate service account credentials and compute instance metadata"
  permissions = ["iam.serviceAccounts.get", "iam.serviceAccountKeys.get", "compute.instances.get", "compute.instanceGroups.list"]
}


data "google_iam_role" "storage_object_creator" {
  name = "roles/storage.objectCreator"
}

# The one permission Prowler needs that `roles/viewer` does not carry. Reading a
# bucket's IAM policy is how the public-access checks tell a private bucket from
# one granted to allUsers, and Viewer stops short of it.
resource "google_organization_iam_custom_role" "prowler_scanner" {
  role_id     = "prowlerScanner"
  org_id      = data.google_organization.org.org_id
  title       = "Prowler Scanner"
  description = "Read permissions Prowler needs beyond roles/viewer"
  permissions = ["storage.buckets.getIamPolicy"]
}

resource "google_organization_iam_custom_role" "storage_object_creator_deleter" {
  role_id     = "storageObjectCreatorDeleter"
  org_id      = data.google_organization.org.org_id
  title       = "Storage Object Creator and Deleter"
  description = "Permissions that allow the creation and deletion of storage objects in the organization"
  permissions = concat(data.google_iam_role.storage_object_creator.included_permissions, ["storage.objects.delete"])
}
