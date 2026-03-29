resource "google_pubsub_topic" "audit_log_ingest" {
  name    = "audit-log-ingest"
  project = local.project

  message_retention_duration = "86400s" # 1 day
}

resource "google_pubsub_topic" "audit_log_dlq" {
  name    = "audit-log-dlq"
  project = local.project
}

resource "google_pubsub_subscription" "audit_log_push" {
  name    = "audit-log-push"
  project = local.project
  topic   = google_pubsub_topic.audit_log_ingest.name

  ack_deadline_seconds = 60

  push_config {
    push_endpoint = google_cloud_run_v2_service.audit_pipeline.uri

    oidc_token {
      service_account_email = google_service_account.audit_pipeline.email
    }
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.audit_log_dlq.id
    max_delivery_attempts = 10
  }
}

resource "google_pubsub_subscription" "audit_log_dlq_pull" {
  name    = "audit-log-dlq-pull"
  project = local.project
  topic   = google_pubsub_topic.audit_log_dlq.name
}
