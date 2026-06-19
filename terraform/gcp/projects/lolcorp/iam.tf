resource "google_service_account" "audit_pipeline" {
  account_id   = "audit-pipeline"
  display_name = "Audit Log Analysis Pipeline"
}

resource "google_project_iam_member" "audit_pipeline_bq_editor" {
  project = local.project
  role    = "roles/bigquery.dataEditor"
  member  = google_service_account.audit_pipeline.member
}

resource "google_project_iam_member" "audit_pipeline_bq_job_user" {
  project = local.project
  role    = "roles/bigquery.jobUser"
  member  = google_service_account.audit_pipeline.member
}

resource "google_project_iam_member" "audit_pipeline_vertex_user" {
  project = local.project
  role    = "roles/aiplatform.user"
  member  = google_service_account.audit_pipeline.member
}

data "google_project" "this" {
  project_id = local.project
}

resource "google_project_service_identity" "pubsub" {
  provider = google-beta

  project = data.google_project.this.project_id
  service = "pubsub.googleapis.com"
}

# Allow Pub/Sub service agent to mint OIDC tokens as the audit-pipeline SA
resource "google_service_account_iam_member" "pubsub_token_creator" {
  service_account_id = google_service_account.audit_pipeline.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = google_project_service_identity.pubsub.member
}

# Allow Pub/Sub service agent to invoke Cloud Run
resource "google_cloud_run_v2_service_iam_member" "pubsub_invoker" {
  project  = local.project
  location = "us-central1"
  name     = google_cloud_run_v2_service.audit_pipeline.name
  role     = "roles/run.invoker"
  member   = google_service_account.audit_pipeline.member
}

# Allow org sink writer identity to publish to the topic
# After running `terraform apply` in gcp/organization/, set this variable
# to the audit_sink_writer_identity output value.
variable "audit_sink_writer_identity" {
  description = "Writer identity from the org-level audit log sink (output of gcp/organization/ apply)"
  type        = string
  default     = "serviceAccount:service-org-5046617773@gcp-sa-logging.iam.gserviceaccount.com"
}

resource "google_pubsub_topic_iam_member" "sink_publisher" {
  count   = var.audit_sink_writer_identity != "" ? 1 : 0
  project = local.project
  topic   = google_pubsub_topic.audit_log_ingest.name
  role    = "roles/pubsub.publisher"
  member  = var.audit_sink_writer_identity
}
