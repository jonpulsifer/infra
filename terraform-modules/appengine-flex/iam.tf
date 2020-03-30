resource "google_service_account" "gae" {
  account_id   = format("%s-gae", var.name)
  display_name = "service account for ${var.name} AppEngine instance(s)"
}

resource "google_project_iam_member" "sd" {
  for_each = var.enable_stackdriver ? toset([
    "roles/logging.logWriter",
    "roles/cloudtrace.agent",
    "roles/clouddebugger.agent",
    "roles/cloudprofiler.agent",
    "roles/errorreporting.writer",
    "roles/monitoring.metricWriter",
  ]) : []
  role   = format("%s", each.key)
  member = format("serviceAccount:%s", google_service_account.gae.email)
}

output "service_account" {
  value = google_service_account.gae.email
}

output "service_account_name" {
  value = google_service_account.gae.name
}
