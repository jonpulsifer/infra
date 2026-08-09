# The clusters' read path into this project's Secret Manager. A config item
# written here is fetched back by the Target a Component runs on, and for a
# Kubernetes Target that fetch is external-secrets. Each cluster's operator
# needs its own read path, or an ExternalSecret naming a secret in this
# project resolves nothing.
#
# `roles/secretmanager.secretAccessor` and no wider: the chart renders an
# `ExternalSecret` naming a secret id and a pinned version number, which is
# `secretmanager.versions.access` alone. Nothing here lists, creates or
# describes — `roles/secretmanager.viewer` would only add metadata reads nobody
# makes.
#
# The principal is federated directly rather than through a service account.
# There is nothing for one to carry: the grant is a single read role on a single
# project, so an impersonated account would be an extra identity holding exactly
# the permissions the principal already holds. The Kubernetes service account
# each subject names is declared in `clusters/base/platform/gcp-secret-manager`,
# and the per-cluster provider that mints its token in
# terraform/gcp/projects/homelab-ng/workload-identity.tf.
locals {
  cluster_secret_readers = toset(["folly", "offsite"])
}

resource "google_project_iam_member" "cluster_secret_reader" {
  for_each = local.cluster_secret_readers

  project = local.project
  role    = "roles/secretmanager.secretAccessor"
  member  = "principal://${local.fml_pool}/subject/${each.key}:system:serviceaccount:external-secrets:gcp-secret-manager"
}
