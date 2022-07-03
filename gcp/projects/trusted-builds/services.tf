resource "google_project_service" "service" {
  for_each = toset([
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "cloudscheduler.googleapis.com",
    "workflows.googleapis.com",
  ])
  service            = each.key
  disable_on_destroy = false
}
