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

resource "google_artifact_registry_repository_iam_binding" "admins" {
  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.admin"
  members = [
    "group:cloud@pulsifer.ca"
  ]
}
