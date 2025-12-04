resource "google_iam_workload_identity_pool" "homelab" {
  workload_identity_pool_id = "homelab"
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.homelab.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  attribute_mapping = {
    "google.subject"             = "assertion.sub"
    "attribute.actor"            = "assertion.actor"
    "attribute.repository"       = "assertion.repository"
    "attribute.repository_owner" = "assertion.repository_owner"
    "attribute.repo_and_branch"  = "assertion.repository + '/' + assertion.ref"
    "attribute.workflow"         = "assertion.job_workflow_ref"
  }

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
  attribute_condition = "assertion.repository_owner == 'jonpulsifer'"
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

  attribute_condition = "assertion.sub.startsWith('owner:jonpulsifers-projects:project:') && assertion.environment == 'production'"
  oidc {
    allowed_audiences = ["https://vercel.com/jonpulsifers-projects"]
    issuer_uri        = "https://oidc.vercel.com/jonpulsifers-projects"
  }

  depends_on = [google_org_policy_policy.allowed_workload_identity_providers]
}
