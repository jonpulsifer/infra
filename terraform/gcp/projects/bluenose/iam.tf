resource "google_service_account" "spindrift_runtime" {
  account_id   = "spindrift-runtime"
  display_name = "Spindrift workload runtime"

  depends_on = [google_project_service.service["iam.googleapis.com"]]
}

resource "google_service_account_iam_member" "spindrift_act_as_runtime" {
  service_account_id = google_service_account.spindrift_runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = local.spindrift_principal
}

locals {
  spindrift_project_roles = toset([
    "roles/cloudsql.admin",
    "roles/compute.networkUser",
    "roles/firebasehosting.admin",
    "roles/iap.admin",
    "roles/redis.admin",
    "roles/run.admin",
    "roles/secretmanager.admin",
    "roles/serviceusage.serviceUsageConsumer",
  ])
}

resource "google_project_iam_member" "spindrift" {
  for_each = local.spindrift_project_roles

  project = local.project
  role    = each.key
  member  = local.spindrift_principal
}
