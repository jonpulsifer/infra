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

  # Repository bundles are ephemeral (Spindrift stages them under ephemeral/,
  # see src/storage/archives.ts EPHEMERAL_PREFIX). Content-addressed objects
  # are never replaced, so the versioned rule above never matches them — these
  # two are what actually expires a git bundle nothing is rebuilding. An
  # overwrite from re-staging the same commit resets the live object's age,
  # which keeps actively built bundles alive.
  lifecycle_rule {
    condition {
      age            = 30
      matches_prefix = ["ephemeral/"]
      with_state     = "LIVE"
    }
    action {
      type = "Delete"
    }
  }

  # Deleting or overwriting a live ephemeral object only archives it while
  # versioning is on; this purges the noncurrent generations left behind.
  lifecycle_rule {
    condition {
      days_since_noncurrent_time = 7
      matches_prefix             = ["ephemeral/"]
      with_state                 = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }

  depends_on = [module.vessel]
}

resource "google_storage_bucket_iam_member" "spindrift_source" {
  bucket = google_storage_bucket.spindrift_source.name
  role   = "roles/storage.admin"
  member = google_service_account.spindrift_controller.member
}

resource "google_storage_bucket_iam_member" "trusted_builder_source" {
  bucket = google_storage_bucket.spindrift_source.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${data.google_project.trusted_builds.number}@cloudbuild.gserviceaccount.com"
}
