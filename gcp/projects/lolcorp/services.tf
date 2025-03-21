resource "google_project_service" "service" {
  for_each = toset([
    # "admin.googleapis.com",
    "bigquery.googleapis.com",
    # "bigquerystorage.googleapis.com",
  ])
  service            = each.key
  disable_on_destroy = false
}
