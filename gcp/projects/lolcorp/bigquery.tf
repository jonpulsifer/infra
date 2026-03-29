resource "google_bigquery_dataset" "audit_anomalies" {
  dataset_id                  = "audit_anomalies"
  location                    = "US"
  default_table_expiration_ms = 7776000000 # 90 days
  delete_contents_on_destroy  = false
}

resource "google_bigquery_table" "anomalies" {
  dataset_id          = google_bigquery_dataset.audit_anomalies.dataset_id
  table_id            = "anomalies"
  deletion_protection = false

  time_partitioning {
    type  = "DAY"
    field = "detected_at"
  }

  clustering = ["principal_email"]

  schema = jsonencode([
    { name = "detected_at", type = "TIMESTAMP", mode = "REQUIRED" },
    { name = "log_timestamp", type = "TIMESTAMP", mode = "REQUIRED" },
    { name = "principal_email", type = "STRING", mode = "REQUIRED" },
    { name = "method_name", type = "STRING", mode = "REQUIRED" },
    { name = "resource_name", type = "STRING", mode = "NULLABLE" },
    { name = "project_id", type = "STRING", mode = "NULLABLE" },
    { name = "severity_score", type = "INTEGER", mode = "REQUIRED" },
    { name = "anomaly_type", type = "STRING", mode = "REQUIRED" },
    { name = "explanation", type = "STRING", mode = "NULLABLE" },
    { name = "raw_log", type = "JSON", mode = "NULLABLE" },
    { name = "toon_payload", type = "STRING", mode = "NULLABLE" },
  ])
}

resource "google_bigquery_data_transfer_config" "anomaly_clusters" {
  display_name   = "Retrain anomaly KMEANS clusters"
  location       = "US"
  data_source_id = "scheduled_query"
  schedule       = "every monday 02:00"

  service_account_name = google_service_account.audit_pipeline.email

  params = {
    query = file("${path.module}/sql/tuning.sql")
  }
}
