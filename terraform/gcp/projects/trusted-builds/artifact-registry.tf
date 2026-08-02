resource "google_artifact_registry_repository" "images" {
  location      = local.region
  repository_id = "i"
  description   = "where the containers lie"
  format        = "DOCKER"
  vulnerability_scanning_config {
    enablement_config = "DISABLED"
  }

  cleanup_policy_dry_run = false
  cleanup_policies {
    id     = "delete-untagged"
    action = "DELETE"
    condition {
      older_than = "24h"
    }
  }
}

resource "google_artifact_registry_repository_iam_member" "reader_vault" {
  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:service-629296473058@serverless-robot-prod.iam.gserviceaccount.com"
}

data "google_project" "bluenose" {
  project_id = "bluenose"
}

resource "google_artifact_registry_repository_iam_member" "reader_spindrift" {
  for_each = toset([
    local.bluenose_binary_authorization_service_agent,
    local.spindrift_controller_member,
    "serviceAccount:service-${data.google_project.bluenose.number}@serverless-robot-prod.iam.gserviceaccount.com",
  ])

  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.reader"
  member     = each.key
}

# The hosted build route pushes here as well as to GHCR.
#
# Cloud Run cannot pull the GHCR artifact: it goes through a cache mirror that
# could not parse an OCI index carrying provenance, an SBOM and a signature, and
# the revision failed at the pull with a digest that was not the one deployed.
# Every reader below was already granted; nothing wrote. This is the writer.
#
# The same principalSet the attestation steps federate as, so the job holds one
# identity for signing, attesting and pushing rather than a registry credential
# stored somewhere.
resource "google_artifact_registry_repository_iam_member" "writer_builds" {
  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.writer"
  member     = "principalSet://iam.googleapis.com/projects/629296473058/locations/global/workloadIdentityPools/homelab/attribute.repository_owner/jonpulsifer"
}

# What an operator puts in `supplyChain.registry` alongside the GHCR namespace.
# A namespace and not a repository: core appends `{app}/{component}`.
output "registry_namespace" {
  description = "Artifact Registry namespace Spindrift publishes to."
  value       = "${local.region}-docker.pkg.dev/${local.project}/${google_artifact_registry_repository.images.repository_id}"
}

resource "google_artifact_registry_repository_iam_binding" "admins" {
  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.admin"
  members = [
    "group:cloud@pulsifer.ca"
  ]
}
