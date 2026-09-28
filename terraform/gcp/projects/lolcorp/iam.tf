resource "google_service_account" "audit_pipeline" {
  account_id   = "audit-pipeline"
  display_name = "Audit Log Analysis Pipeline"
}
