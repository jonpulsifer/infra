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

# The kthx depot: every release archive under `releases/<digest>.tar.gz`, every
# site's uploaded files under `files/<site>/`, and the nightly `pg_dumpall`
# under `backups/pg/`. Same region as the source depot above — both are read
# from offsite.
resource "google_storage_bucket" "kthx" {
  name                        = "bluenose-kthx"
  location                    = local.region
  force_destroy               = false
  uniform_bucket_level_access = true

  versioning {
    enabled = true
  }

  # Backups are the only prefix that expires on age. Release archives are
  # content-addressed and a release row points at one by digest, so nothing
  # here may delete them on age; the server's own sweep is what drops the ones
  # no row references.
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

  # Deleting or overwriting a live object only archives it while versioning is
  # on, so without this nothing in the bucket ever reclaims a byte. Bucket-wide
  # rather than scoped to a prefix: deleting a site has to actually delete the
  # files uploaded to it, the server's release sweep has to actually reclaim,
  # and `PUT /api/files/<path>` takes anonymous writes — overwrites of one path
  # would otherwise grow the bucket without bound under a per-site quota that
  # only ever meters live objects.
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
