resource "google_cloud_run_v2_service" "audit_pipeline" {
  name     = "audit-pipeline"
  location = "us-central1"
  ingress  = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  template {
    scaling {
      min_instance_count = 0
      max_instance_count = 2
    }

    containers {
      image = "us-central1-docker.pkg.dev/lolcorp/cloud-run-source-deploy/audit-pipeline@sha256:8db07cd92c6056631bd6889fd6ff70f686ae9203b2c48b8ee8904b1c0646e24e"

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle = true
      }

      env {
        name  = "GCP_PROJECT"
        value = local.project
      }
      env {
        name  = "BQ_DATASET"
        value = google_bigquery_dataset.audit_anomalies.dataset_id
      }
      env {
        name  = "BQ_TABLE"
        value = google_bigquery_table.anomalies.table_id
      }
      env {
        name  = "VERTEX_LOCATION"
        value = "us-central1"
      }
      env {
        name  = "VERTEX_MODEL"
        value = "gemini-2.5-flash-lite"
      }
      env {
        name  = "SEVERITY_THRESHOLD"
        value = "7"
      }
    }

    service_account = google_service_account.audit_pipeline.email
  }
}
