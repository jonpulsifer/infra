locals {
  # Repos allowed to mint tokens from the shared "homelab" GitHub OIDC provider.
  # This only gates who can authenticate at all; what each repo can then do is
  # scoped separately by per-resource IAM bindings (see iam.tf, datastore.tf).
  github_actions_allowed_repository_ids = [
    "952814997", # jonpulsifer/infra
    "554977933", # jonpulsifer/ts
  ]
}

resource "google_iam_workload_identity_pool" "homelab" {
  workload_identity_pool_id = "homelab"
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.homelab.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  attribute_mapping = {
    "google.subject"                = "assertion.sub"
    "attribute.actor"               = "assertion.actor"
    "attribute.repository"          = "assertion.repository"
    "attribute.repository_id"       = "assertion.repository_id"
    "attribute.repository_owner"    = "assertion.repository_owner"
    "attribute.repository_owner_id" = "assertion.repository_owner_id"
    "attribute.repo_and_branch"     = "assertion.repository + '/' + assertion.ref"
    "attribute.workflow"            = "assertion.job_workflow_ref"
  }

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
  attribute_condition = "assertion.repository_owner_id == '5461940' && assertion.repository_id in ${jsonencode(local.github_actions_allowed_repository_ids)}"
  depends_on          = [google_org_policy_policy.allowed_workload_identity_providers]
}

resource "google_iam_workload_identity_pool_provider" "vercel" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.homelab.workload_identity_pool_id
  workload_identity_pool_provider_id = "vercel"
  attribute_mapping = {
    "google.subject"        = "assertion.sub"
    "attribute.project"     = "assertion.project"
    "attribute.environment" = "assertion.environment"
  }

  attribute_condition = "assertion.sub.startsWith('owner:jonpulsifer:project:')"
  oidc {
    allowed_audiences = ["https://vercel.com/jonpulsifer"]
    issuer_uri        = "https://oidc.vercel.com/jonpulsifer"
  }

  depends_on = [google_org_policy_policy.allowed_workload_identity_providers]
}
