# Nothing in this root writes here: no build step, no workflow, no schedule. The
# bucket is declared because its objects still exist and `force_destroy = false`
# means a removal fails on them rather than deleting them. Remove it with its
# policy once the objects are accounted for.
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
    ]
  }
}

resource "google_storage_bucket_iam_policy" "trusted_artifacts" {
  bucket      = google_storage_bucket.trusted_artifacts.name
  policy_data = data.google_iam_policy.trusted_artifacts.policy_data
}
