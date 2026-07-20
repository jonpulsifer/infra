# Project-level org-policy overrides every Firebase project needs.

# firebase needs a service account
resource "google_org_policy_policy" "allow_service_accounts" {
  name   = "projects/${var.project}/policies/iam.disableServiceAccountCreation"
  parent = "projects/${var.project}"
  spec {
    rules {
      enforce = "FALSE"
    }
  }
}

# firebase needs keys
resource "google_org_policy_policy" "allow_service_account_keys" {
  name   = "projects/${var.project}/policies/iam.disableServiceAccountKeyCreation"
  parent = "projects/${var.project}"
  spec {
    rules {
      enforce = "FALSE"
    }
  }
}

# firebase needs a bucket
resource "google_org_policy_policy" "allowed_storage_retention_policy_seconds" {
  name   = "projects/${var.project}/policies/storage.retentionPolicySeconds"
  parent = "projects/${var.project}"
  spec {
    inherit_from_parent = false
    rules {
      allow_all = "TRUE"
    }
  }
}
