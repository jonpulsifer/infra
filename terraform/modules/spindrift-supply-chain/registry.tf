resource "google_artifact_registry_repository_iam_member" "reader" {
  for_each = toset(var.registry_readers)

  project    = var.project
  location   = var.location
  repository = var.repository
  role       = "roles/artifactregistry.reader"
  member     = each.key
}

# Writers default to the attesters: every route that signs also pushes an image or signature.
resource "google_artifact_registry_repository_iam_member" "writer" {
  for_each = toset(local.registry_writers)

  project    = var.project
  location   = var.location
  repository = var.repository
  role       = "roles/artifactregistry.writer"
  member     = each.key
}
