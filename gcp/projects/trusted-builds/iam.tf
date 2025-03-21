resource "google_service_account" "base_updater" {
  account_id = "updater"
}

resource "google_project_iam_member" "base_updater_workflows" {
  project = local.project
  member  = "serviceAccount:${google_service_account.base_updater.email}"
  role    = "roles/workflows.invoker"
}

resource "google_project_iam_member" "base_updater_builds" {
  project = local.project
  member  = "serviceAccount:${google_service_account.base_updater.email}"
  role    = "roles/cloudbuild.builds.editor"
}
