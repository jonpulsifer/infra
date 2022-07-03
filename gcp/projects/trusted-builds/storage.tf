resource "google_storage_bucket" "trusted_artifacts" {
  name                        = "trusted-artifacts"
  location                    = local.region
  requester_pays              = false
  force_destroy               = false
  storage_class               = "STANDARD"
  uniform_bucket_level_access = "true"
}

data "google_iam_policy" "trusted_artifacts" {
  binding {
    role = "roles/storage.admin"
    members = [
      "group:cloud@pulsifer.ca",
      format("serviceAccount:%s@cloudbuild.gserviceaccount.com", data.google_project.current.number),
      format("serviceAccount:%s", google_service_account.base_updater.email),
    ]
  }
}

resource "google_storage_bucket_iam_policy" "trusted_artifacts" {
  bucket      = google_storage_bucket.trusted_artifacts.name
  policy_data = data.google_iam_policy.trusted_artifacts.policy_data
}
