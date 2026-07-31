resource "google_storage_bucket" "spindrift_source" {
  name                        = "bluenose-spindrift-source"
  location                    = local.region
  force_destroy               = false
  uniform_bucket_level_access = true

  versioning {
    enabled = true
  }

  lifecycle_rule {
    condition {
      age                = 30
      num_newer_versions = 10
      with_state         = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }

  depends_on = [google_project_service.service["storage.googleapis.com"]]
}

resource "google_storage_bucket_iam_member" "spindrift_source" {
  bucket = google_storage_bucket.spindrift_source.name
  role   = "roles/storage.objectAdmin"
  member = google_service_account.spindrift_controller.member
}

resource "google_storage_bucket_iam_member" "trusted_builder_source" {
  bucket = google_storage_bucket.spindrift_source.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${data.google_project.trusted_builds.number}@cloudbuild.gserviceaccount.com"
}
