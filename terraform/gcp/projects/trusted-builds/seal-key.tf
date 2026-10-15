# The private half of a hosted build route's sealPublicKey, which opens sealed run inputs. The version is
# added out of band with gcloud secrets versions add, so the key stays out of state.
resource "google_secret_manager_secret" "kthx_engine_build_seal_key" {
  secret_id = "spindrift-build-seal-key"

  replication {
    auto {}
  }

  depends_on = [google_project_service.service["secretmanager.googleapis.com"]]
}

moved {
  from = google_secret_manager_secret.spindrift_build_seal_key
  to   = google_secret_manager_secret.kthx_engine_build_seal_key
}

resource "google_secret_manager_secret_iam_member" "kthx_engine_build_seal_key_accessor" {
  secret_id = google_secret_manager_secret.kthx_engine_build_seal_key.id
  role      = "roles/secretmanager.secretAccessor"
  member    = local.spindrift_build_workflow_principal
}

moved {
  from = google_secret_manager_secret_iam_member.spindrift_build_seal_key_accessor
  to   = google_secret_manager_secret_iam_member.kthx_engine_build_seal_key_accessor
}

resource "google_secret_manager_secret_iam_member" "kthx_engine_build_seal_key_accessor_renamed_workflow" {
  secret_id = google_secret_manager_secret.kthx_engine_build_seal_key.id
  role      = "roles/secretmanager.secretAccessor"
  member    = local.kthx_engine_build_workflow_principal
}

resource "google_secret_manager_secret" "kthx_engine_build_seal_key_named" {
  secret_id = "kthx-engine-build-seal-key"

  replication {
    auto {}
  }

  depends_on = [google_project_service.service["secretmanager.googleapis.com"]]
}

# Both build workflow names read the seal key until the old one is retired.
resource "google_secret_manager_secret_iam_member" "kthx_engine_build_seal_key_named_accessor" {
  for_each  = toset([local.spindrift_build_workflow_principal, local.kthx_engine_build_workflow_principal])
  secret_id = google_secret_manager_secret.kthx_engine_build_seal_key_named.id
  role      = "roles/secretmanager.secretAccessor"
  member    = each.value
}
