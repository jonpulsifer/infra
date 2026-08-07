resource "google_artifact_registry_repository" "images" {
  location      = local.region
  repository_id = "i"
  description   = "where the containers lie"
  format        = "DOCKER"
  vulnerability_scanning_config {
    enablement_config = "DISABLED"
  }

  # Everything goes after a day, tagged included, and that is the point. This
  # repository is staging for Cloud Run, not an archive: every build pushes one
  # digest to GHCR, Docker Hub and here, the first two host it for free, and
  # retaining it in a billed repository is paying twice for the same bytes.
  #
  # Nothing serving depends on it — "Cloud Run keeps this copy of the container
  # image as long as it is used by a serving revision". What it costs is a
  # redeploy older than a day, which rebuilds; rollbacks here happen well inside
  # the window. The digest is still in GHCR either way, but Cloud Run cannot
  # pull that index, which is the whole reason this repository exists.
  #
  # `tag_state` is stated rather than defaulted because the default *is* `ANY`,
  # and a policy that reads `delete-untagged` while deleting everything invites
  # someone to "fix" it into a bill.
  cleanup_policy_dry_run = false
  cleanup_policies {
    id     = "delete-after-a-day"
    action = "DELETE"
    condition {
      tag_state  = "ANY"
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

# The other two writers, which the cloud build route needs and the hosted one
# does not. `writer_builds` above is the workflow run federating in as itself;
# a cloud build has no run, so both halves of what it does are named here.
#
#   * The Cloud Build worker is what executes the build step and pushes.
#   * The controller signs. `CoreSupplyChain.finalize` signs every admitted
#     artifact whatever route built it, and a cosign signature is an object in
#     the repository — so core's own signature is a write. The hosted route's
#     job signs before core does and never needed this; a cloud build has
#     nothing else that could.
resource "google_artifact_registry_repository_iam_member" "writer_cloud_build" {
  for_each = toset([
    local.cloud_build_worker_member,
    local.spindrift_controller_member,
  ])

  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.writer"
  member     = each.key
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
