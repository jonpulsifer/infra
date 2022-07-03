resource "google_cloud_run_service" "vault" {
  name     = "vault"
  location = "northamerica-northeast1"

  template {
    metadata {
      annotations = {
        "autoscaling.knative.dev/maxScale" = 1
        "autoscaling.knative.dev/minScale" = 0
      }
    }
    spec {
      containers {
        image = "northamerica-northeast1-docker.pkg.dev/trusted-builds/i/vault:latest"
        args  = ["server"]
        ports {
          container_port = 8200
          name           = "http1"
        }
        resources {
          limits = {
            "cpu"    = "1000m"
            "memory" = "256Mi"
          }
        }
        env {
          name = "VAULT_LOCAL_CONFIG"
          value = jsonencode({
            "api_addr"                     = "https://0.0.0.0:8200"
            "default_max_request_duration" = "30s",
            "disable_clustering"           = "true",
            "disable_mlock"                = "true",
            "listener" = [{
              "tcp" = {
                "address"     = "0.0.0.0:8200",
                "tls_disable" = "true",
              }
            }],
            "seal" = {
              "gcpckms" = {
                "project"    = local.project,
                "region"     = local.region,
                "key_ring"   = google_kms_key_ring.vault.name,
                "crypto_key" = google_kms_crypto_key.vault.name,
              }
            }
            "storage" = {
              "gcs" = {
                "bucket"     = google_storage_bucket.vault.name,
                "ha_enabled" = "false",
              }
            }
            "ui" = "true"
          })
        }
        env {
          name  = "SKIP_SETCAP"
          value = "true"
        }
      }
      service_account_name = google_service_account.vault.email
      timeout_seconds      = 60
    }
  }
}

data "google_iam_policy" "noauth" {
  binding {
    role = "roles/run.invoker"
    members = [
      "allUsers",
    ]
  }
}

resource "google_cloud_run_service_iam_policy" "noauth" {
  location = google_cloud_run_service.vault.location
  project  = google_cloud_run_service.vault.project
  service  = google_cloud_run_service.vault.name

  policy_data = data.google_iam_policy.noauth.policy_data
}
