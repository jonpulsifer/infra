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

resource "google_organization_iam_custom_role" "storage_object_creator_deleter" {
  role_id     = "storageObjectCreatorDeleter"
  org_id      = data.google_organization.org.org_id
  title       = "Storage Object Creator and Deleter"
  description = "Permissions that allow the creation and deletion of storage objects in the organization"
  permissions = concat(data.google_iam_role.storage_object_creator.included_permissions, ["storage.objects.delete"])
}
