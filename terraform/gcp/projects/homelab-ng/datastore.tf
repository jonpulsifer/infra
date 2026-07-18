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

# TypeScript CI uses direct Workload Identity Federation from the infra repo.
# It only needs read access; no service-account impersonation is involved.
resource "google_project_iam_binding" "firestore_database_reader" {
  project = local.project
  role    = "roles/datastore.viewer"
  members = [local.infra_github_actions_principal]
}
