# Grants on a repository the module does not own. Readers are the per-vessel
# pull principals; writers default to the attesters because every route that
# signs also pushes — the hosted job pushes what it built, the Cloud Build
# worker pushes as a build step, and the controller's own cosign signature is
# an object in the repository.

resource "google_artifact_registry_repository_iam_member" "reader" {
  for_each = toset(var.registry_readers)

  project    = var.project
  location   = var.location
  repository = var.repository
  role       = "roles/artifactregistry.reader"
  member     = each.key
}

resource "google_artifact_registry_repository_iam_member" "writer" {
  for_each = toset(local.registry_writers)

  project    = var.project
  location   = var.location
  repository = var.repository
  role       = "roles/artifactregistry.writer"
  member     = each.key
}
