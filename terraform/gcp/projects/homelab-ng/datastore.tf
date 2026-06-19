resource "google_firestore_database" "default" {
  name        = "(default)"
  location_id = "northamerica-northeast1"
  type        = "FIRESTORE_NATIVE"
}

resource "google_project_iam_binding" "firestore_database_user" {
  project = local.project
  role    = "roles/datastore.user"
  members = concat(
    [google_service_account.view_counter.member],
    local.slingshot_principals
  )
}

resource "google_project_iam_binding" "firestore_database_reader" {
  project = local.project
  role    = "roles/datastore.viewer"
  members = ["principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.homelab.name}/attribute.repository/jonpulsifer/ts"]
}