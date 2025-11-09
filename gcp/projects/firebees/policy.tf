# firebase needs a service account D:
resource "google_org_policy_policy" "allow_service_accounts" {
  name   = "projects/${local.project}/policies/iam.disableServiceAccountCreation"
  parent = "projects/${local.project}"
  spec {
    rules {
      enforce = "FALSE"
    }
  }
}

# firebase needs keys
resource "google_org_policy_policy" "allow_service_account_keys" {
  name   = "projects/${local.project}/policies/iam.disableServiceAccountKeyCreation"
  parent = "projects/${local.project}"
  spec {
    rules {
      enforce = "FALSE"
    }
  }
}

# firebase needs a bucket
resource "google_org_policy_policy" "allowed_storage_retention_policy_seconds" {
  name   = "projects/${local.project}/policies/storage.retentionPolicySeconds"
  parent = "projects/${local.project}"
  spec {
    inherit_from_parent = false
    rules {
      allow_all = "TRUE"
    }
  }
}
