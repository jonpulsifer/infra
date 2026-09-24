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

  # Bundles under ephemeral/ never reach 10 newer versions, so only these two rules expire them.
  # Re-staging a commit overwrites its bundle, which resets its age.
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

  # With versioning on, a delete or overwrite only archives the live object.
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

# The kthx depot: release archives under releases/, site files under files/<site>/,
# and database dumps under backups/pg/.
resource "google_storage_bucket" "kthx" {
  name                        = "bluenose-kthx"
  location                    = local.region
  force_destroy               = false
  uniform_bucket_level_access = true

  versioning {
    enabled = true
  }

  # Only backups expire on age. A release row points at its archive by digest, and the
  # server's sweep deletes archives that no row references.
  lifecycle_rule {
    condition {
      age            = 30
      matches_prefix = ["backups/"]
      with_state     = "LIVE"
    }
    action {
      type = "Delete"
    }
  }

  # With versioning on, deletes and overwrites only archive. Bucket-wide because site quotas meter
  # live objects only, and any anonymous visitor can overwrite their own files without limit.
  lifecycle_rule {
    condition {
      days_since_noncurrent_time = 7
      with_state                 = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }

  depends_on = [module.vessel]
}

resource "google_storage_bucket_iam_member" "kthx" {
  bucket = google_storage_bucket.kthx.name
  role   = "roles/storage.objectAdmin"
  member = google_service_account.kthx.member
}
