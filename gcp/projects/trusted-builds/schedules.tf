resource "google_cloud_scheduler_job" "builder_nightly" {
  name             = "builder-nightly"
  description      = "Nightly Workflow Trigger"
  schedule         = "0 8 * * *"
  time_zone        = "America/Halifax"
  attempt_deadline = "60s"

  http_target {
    http_method = "POST"
    uri         = "https://workflowexecutions.googleapis.com/v1/projects/trusted-builds/locations/northamerica-northeast1/workflows/atolla/executions"

    oauth_token {
      service_account_email = google_service_account.base_updater.email
    }
  }
}
