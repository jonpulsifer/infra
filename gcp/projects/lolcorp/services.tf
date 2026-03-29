resource "google_project_service" "service" {
  for_each = toset([
    # "admin.googleapis.com",
    "aiplatform.googleapis.com",
    "artifactregistry.googleapis.com",
    "bigquery.googleapis.com",
    "bigquerydatatransfer.googleapis.com",
    # "bigquerystorage.googleapis.com",
    "cloudbuild.googleapis.com",
    "iam.googleapis.com",
    "logging.googleapis.com",
    "pubsub.googleapis.com",
    "run.googleapis.com",
  ])
  service            = each.key
  disable_on_destroy = false
}
