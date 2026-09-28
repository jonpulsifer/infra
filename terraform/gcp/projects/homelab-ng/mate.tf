# The nightly dump of mate's session database, clusters/offsite/apps/mate/database-backup.yaml.
# Keyless: impersonated with the offsite cluster's projected token through the fml pool.
resource "google_service_account" "mate_db_backup" {
  account_id   = "mate-db-backup"
  display_name = "mate database backup"
  description  = "Writes the nightly dump of mate's session database, impersonated from the offsite cluster by workload identity federation"
}

# The provider admits any ServiceAccount in the cluster, so this names the backup Job's KSA.
resource "google_service_account_iam_member" "mate_db_backup_offsite_workload_identity" {
  service_account_id = google_service_account.mate_db_backup.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principal://iam.googleapis.com/${google_iam_workload_identity_pool.fml.name}/subject/offsite:system:serviceaccount:mate:mate-db-backup"
}

# Dumps land under backups/pg/.
resource "google_storage_bucket" "mate" {
  name                        = join("-", [local.project, "mate"])
  location                    = local.region
  force_destroy               = false
  uniform_bucket_level_access = true

  versioning {
    enabled = true
  }

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

  # With versioning on, a delete or an overwrite only archives the live object.
  lifecycle_rule {
    condition {
      days_since_noncurrent_time = 7
      with_state                 = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }
}

# objectAdmin, because a rerun on the same day overwrites that day's dump.
data "google_iam_policy" "gcs_mate" {
  binding {
    role = "roles/storage.admin"
    members = [
      "group:cloud@pulsifer.ca",
    ]
  }

  binding {
    role = "roles/storage.objectAdmin"
    members = [
      google_service_account.mate_db_backup.member,
    ]
  }
}

resource "google_storage_bucket_iam_policy" "mate" {
  bucket      = google_storage_bucket.mate.name
  policy_data = data.google_iam_policy.gcs_mate.policy_data
}
