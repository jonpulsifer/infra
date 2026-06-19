resource "google_org_policy_policy" "allow_service_accounts" {
  name   = "projects/${local.project}/policies/iam.disableServiceAccountCreation"
  parent = "projects/${local.project}"
  spec {
    rules {
      enforce = "FALSE"
    }
  }
}

resource "google_org_policy_policy" "allowed_cloud_build_worker_pools" {
  name   = "projects/${local.project}/policies/cloudbuild.allowedWorkerPools"
  parent = "projects/${local.project}"
  spec {
    inherit_from_parent = false
    rules {
      allow_all = "TRUE"
    }
  }
}

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
