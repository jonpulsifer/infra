locals {
  # Repos allowed to mint tokens from the shared "homelab" GitHub OIDC provider.
  # This only gates who can authenticate at all; what each repo can then do is
  # scoped separately by per-resource IAM bindings (see iam.tf, datastore.tf).
  github_actions_allowed_repository_ids = [
    "952814997", # jonpulsifer/infra
  ]

  # IAM grants use the immutable repository ID mapping so a repository rename
  # does not interrupt direct GitHub Actions federation.
  infra_github_actions_principal = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.homelab.name}/attribute.repository_id/952814997"
}

resource "google_iam_workload_identity_pool" "homelab" {
  workload_identity_pool_id = "homelab"
}

# Org policy changes to iam.workloadIdentityPoolProviders are eventually
# consistent — GCP can reject a provider create/update against the *old*
# allowed_values for a minute or two even after the policy update has been
# applied. Force a delay here, and re-trigger it whenever allowed_values
# changes, so provider resources don't race the policy's propagation.
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
  attribute_condition = "assertion.repository_owner_id == '5461940' && assertion.repository_id in ${jsonencode(local.github_actions_allowed_repository_ids)}"
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
  oidc {
    allowed_audiences = ["https://vercel.com/jonpulsifer"]
    issuer_uri        = "https://oidc.vercel.com/jonpulsifer"
  }

  depends_on = [time_sleep.workload_identity_org_policy_propagation]
}

# Cluster workload identities: each cluster's kube-apiserver is an OIDC issuer
# (SA token signer issued by terraform/pki; discovery docs + JWKS served at
# oidc.lolwtf.ca via Cloudflare Pages). Separate pool from "homelab" so cluster
# workloads and CI identities never share a principalSet namespace. One provider
# per cluster — the clusters have distinct issuers/keys because their SA
# subjects (system:serviceaccount:ns:name) would otherwise be indistinguishable.
# ("fml-pool" because GCP requires pool IDs of 4+ chars — bare "fml" is too short.)
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

  # Only bound (projected) ServiceAccount tokens federate; IAM grants must add
  # their own namespace/serviceaccount conditions — never grant pool-wide.
  attribute_condition = "assertion.sub.startsWith('system:serviceaccount:')"

  oidc {
    issuer_uri = "${local.fml_issuer_base}/${each.key}"
  }

  depends_on = [time_sleep.workload_identity_org_policy_propagation]
}
