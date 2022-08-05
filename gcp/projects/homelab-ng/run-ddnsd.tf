resource "google_cloud_run_service" "ddnsd" {
  name     = "ddnsd"
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
        image = "northamerica-northeast1-docker.pkg.dev/trusted-builds/i/ddnsd:latest"
        ports {
          container_port = 8080
          name           = "http1"
        }
        resources {
          limits = {
            "cpu"    = "1000m"
            "memory" = "256Mi"
          }
        }
      }
      service_account_name = google_service_account.ddnsd.email
      timeout_seconds      = 60
    }
  }
}

resource "google_cloud_run_service_iam_policy" "ddnsd-noauth" {
  location = google_cloud_run_service.ddnsd.location
  project  = google_cloud_run_service.ddnsd.project
  service  = google_cloud_run_service.ddnsd.name

  policy_data = data.google_iam_policy.noauth.policy_data
}

data "google_iam_policy" "noauth" {
  binding {
    role = "roles/run.invoker"
    members = [
      "allUsers",
    ]
  }
}
