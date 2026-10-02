# Each site's Garage buckets are copied here, rclone-encrypted, by the backup-push CronJob in its backups namespace.
# Keyless: impersonated with the site cluster's projected token through the fml pool.
resource "google_service_account" "backups" {
  for_each = local.fml_clusters

  account_id   = "backups-${each.key}"
  display_name = "${each.key} backups"
  description  = "Copies the ${each.key} Garage buckets to its bucket, impersonated from the ${each.key} cluster by workload identity federation"
}

# The provider admits any ServiceAccount in the cluster, so this names the push Job's KSA.
resource "google_service_account_iam_member" "backups_workload_identity" {
  for_each = local.fml_clusters

  service_account_id = google_service_account.backups[each.key].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principal://iam.googleapis.com/${google_iam_workload_identity_pool.fml.name}/subject/${each.key}:system:serviceaccount:backups:backup-push"
}

# The push mirrors Garage, so a delete there deletes here. Versioning keeps what a sync removes or
# overwrites for 30 days.
resource "google_storage_bucket" "backups" {
  for_each = local.fml_clusters

  name                        = join("-", [local.project, "backups-${each.key}"])
  location                    = local.region
  storage_class               = "STANDARD"
  force_destroy               = false
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  versioning {
    enabled = true
  }

  lifecycle_rule {
    condition {
      days_since_noncurrent_time = 30
      with_state                 = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }
}

# objectAdmin, because the push job deletes what Garage no longer holds.
data "google_iam_policy" "gcs_backups" {
  for_each = local.fml_clusters

  binding {
    role = "roles/storage.admin"
    members = [
      "group:cloud@pulsifer.ca",
    ]
  }

  binding {
    role = "roles/storage.objectAdmin"
    members = [
      google_service_account.backups[each.key].member,
    ]
  }
}

resource "google_storage_bucket_iam_policy" "backups" {
  for_each = local.fml_clusters

  bucket      = google_storage_bucket.backups[each.key].name
  policy_data = data.google_iam_policy.gcs_backups[each.key].policy_data
}
