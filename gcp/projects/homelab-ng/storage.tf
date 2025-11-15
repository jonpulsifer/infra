resource "google_storage_bucket" "homelab_ng" {
  name                        = local.project
  location                    = local.region
  requester_pays              = false
  force_destroy               = false
  storage_class               = "REGIONAL"
  uniform_bucket_level_access = "true"
}

data "google_iam_policy" "gcs_homelab_ng" {
  binding {
    role = "roles/storage.admin"
    members = [
      "group:cloud@pulsifer.ca",
    ]
  }
}

resource "google_storage_bucket_iam_policy" "homelab_ng" {
  bucket      = google_storage_bucket.homelab_ng.name
  policy_data = data.google_iam_policy.gcs_homelab_ng.policy_data
}

resource "google_storage_bucket" "vault" {
  name                        = join("-", [local.project, "vault"])
  location                    = local.region
  requester_pays              = false
  force_destroy               = false
  storage_class               = "REGIONAL"
  uniform_bucket_level_access = "true"
}

data "google_iam_policy" "gcs_vault" {
  binding {
    role = "roles/storage.admin"
    members = [
      "group:cloud@pulsifer.ca",
      google_service_account.vault.member,
    ]
  }
}

resource "google_storage_bucket_iam_policy" "vault" {
  bucket      = google_storage_bucket.vault.name
  policy_data = data.google_iam_policy.gcs_vault.policy_data
}

resource "google_storage_bucket" "free" {
  provider = google.free-tier
  name                        = "homelab-ng-free"
  location                    = "us-east1"
  requester_pays              = false
  force_destroy               = false
  storage_class               = "REGIONAL"
  uniform_bucket_level_access = "true"
}

data "google_iam_policy" "free" {
  binding {
    role = "roles/storage.admin"
    members = [
      "group:cloud@pulsifer.ca",
    ]
  }

  binding {
    role = "roles/storage.objectCreator"
    members = [
      "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.homelab.name}/attribute.workflow/jonpulsifer/infra/.github/workflows/nix-image-builder.yaml@refs/heads/main",
    ]
  }
}

resource "google_storage_bucket_iam_policy" "free" {
  bucket      = google_storage_bucket.free.name
  policy_data = data.google_iam_policy.free.policy_data
}