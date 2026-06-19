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

resource "google_artifact_registry_repository_iam_binding" "admins" {
  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.admin"
  members = [
    "group:cloud@pulsifer.ca"
  ]
}
