resource "google_app_engine_application" "homelab" {
  database_type = "CLOUD_FIRESTORE"
  location_id   = "northamerica-northeast1"
  project       = local.project
}
