locals {
  # Listed repositories federate from any workflow. Other repositories of these owners federate
  # only inside the build workflow at main: job_workflow_ref names the called workflow.
  github_actions_allowed_repository_ids = [
    "952814997", # jonpulsifer/infra
  ]
  github_actions_allowed_owner_ids = [
    "5461940",  # jonpulsifer
    "63516210", # homelab-ng
  ]
  spindrift_build_workflow_ref = "jonpulsifer/infra/.github/workflows/spindrift-build.yml@refs/heads/main"

  # A repository ID survives a rename.
  infra_github_actions_principal = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.homelab.name}/attribute.repository_id/952814997"
}

resource "google_iam_workload_identity_pool" "homelab" {
  workload_identity_pool_id = "homelab"
}

# For a minute or two after an allowed_values change, GCP checks provider writes
# against the old iam.workloadIdentityPoolProviders values.
resource "time_sleep" "workload_identity_org_policy_propagation" {
  depends_on      = [google_org_policy_policy.allowed_workload_identity_providers]
  create_duration = "120s"

  triggers = {
    allowed_values = jsonencode(google_org_policy_policy.allowed_workload_identity_providers.spec[0].rules[0].values[0].allowed_values)
  }
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
  attribute_condition = "assertion.repository_owner_id in ${jsonencode(local.github_actions_allowed_owner_ids)} && (assertion.repository_id in ${jsonencode(local.github_actions_allowed_repository_ids)} || assertion.job_workflow_ref == '${local.spindrift_build_workflow_ref}')"
  depends_on          = [time_sleep.workload_identity_org_policy_propagation]
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
  # Vercel sets aud to this provider's full resource name, the GCP default audience.
  # Setting allowed_audiences replaces that default and rejects the token.
  oidc {
    issuer_uri = "https://oidc.vercel.com/jonpulsifer"
  }

  depends_on = [time_sleep.workload_identity_org_policy_propagation]
}

# Each cluster's kube-apiserver is an OIDC issuer. A pool apart from "homelab" keeps
# cluster and CI principalSets apart. Pool IDs need at least 4 characters, hence fml-pool.
locals {
  fml_clusters    = toset(["folly", "offsite"])
  fml_issuer_base = "https://oidc.lolwtf.ca"
}

resource "google_iam_workload_identity_pool" "fml" {
  workload_identity_pool_id = "fml-pool"
}

resource "google_iam_workload_identity_pool_provider" "fml_k8s" {
  for_each = local.fml_clusters

  workload_identity_pool_id          = google_iam_workload_identity_pool.fml.workload_identity_pool_id
  workload_identity_pool_provider_id = each.key

  attribute_mapping = {
    # Provider IDs are not part of a pool principal URI. Prefix the mapped
    # subject so identically named KSAs in different clusters stay distinct.
    "google.subject"           = "'${each.key}:' + assertion.sub"
    "attribute.namespace"      = "assertion['kubernetes.io']['namespace']"
    "attribute.serviceaccount" = "assertion['kubernetes.io']['serviceaccount']['name']"
  }

  # Admits any ServiceAccount token, so each grant must name the cluster-prefixed subject;
  # never grant pool-wide or on namespace/serviceaccount attributes alone.
  attribute_condition = "assertion.sub.startsWith('system:serviceaccount:')"

  oidc {
    issuer_uri = "${local.fml_issuer_base}/${each.key}"
  }

  depends_on = [time_sleep.workload_identity_org_policy_propagation]
}
