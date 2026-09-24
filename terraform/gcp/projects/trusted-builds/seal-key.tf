# The private half of a hosted build route's sealPublicKey, which opens sealed run inputs. The version is
# added out of band with gcloud secrets versions add, so the key stays out of state.
resource "google_secret_manager_secret" "spindrift_build_seal_key" {
  secret_id = "spindrift-build-seal-key"

  replication {
    auto {}
  }

  depends_on = [google_project_service.service["secretmanager.googleapis.com"]]
}

resource "google_secret_manager_secret_iam_member" "spindrift_build_seal_key_accessor" {
  secret_id = google_secret_manager_secret.spindrift_build_seal_key.id
  role      = "roles/secretmanager.secretAccessor"
  member    = local.spindrift_build_workflow_principal
}
