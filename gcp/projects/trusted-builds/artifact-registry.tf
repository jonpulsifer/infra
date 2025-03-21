resource "google_artifact_registry_repository" "images" {
  provider = google-beta

  location      = local.region
  repository_id = "i"
  description   = "where the containers lie"
  format        = "DOCKER"
}

resource "google_artifact_registry_repository_iam_member" "reader_vault" {
  provider = google-beta

  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:service-629296473058@serverless-robot-prod.iam.gserviceaccount.com"
}

resource "google_artifact_registry_repository_iam_binding" "admins" {
  provider = google-beta

  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.admin"
  members = [
    "group:cloud@pulsifer.ca"
  ]
}
