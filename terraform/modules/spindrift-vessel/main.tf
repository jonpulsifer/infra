# The shape every vessel project repeats: its APIs, the identities that act and run in it,
# and the admission policy every container must pass. Home-vessel-only pieces stay in that root.
#
# ponytail: `services` and `controller_roles` have no defaults; callers declare them in services.tf
# and iam.tf, which remediation greps for quoted services and roles before it appends a stanza.

resource "google_project_service" "service" {
  for_each = toset(var.services)

  project            = var.project
  service            = each.key
  disable_on_destroy = false
}

resource "google_service_account" "runtime" {
  project      = var.project
  account_id   = var.runtime_account_id
  display_name = "Spindrift workload runtime"

  depends_on = [google_project_service.service]
}

# The controller needs iam.serviceAccounts.actAs to write Cloud Run revisions and
# Cloud Scheduler jobs that run as the runtime account.
resource "google_service_account_iam_member" "controller_acts_as_runtime" {
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = var.controller_member
}

# Cloud Run reads a revision's secret env vars as the runtime account. The secrets
# are named at deploy time, so the grant is project-wide.
resource "google_project_iam_member" "runtime_secret_reader" {
  project = var.project
  role    = "roles/secretmanager.secretAccessor"
  member  = google_service_account.runtime.member
}

# Connect-time discovery and the SOURCE_BUCKET probe need only storage.buckets.list,
# and every predefined role with it also grants object reads.
resource "google_project_iam_custom_role" "bucket_lister" {
  project     = var.project
  role_id     = "spindriftBucketLister"
  title       = "Spindrift bucket lister"
  description = "List the project's buckets, nothing else"
  permissions = ["storage.buckets.list"]
}

resource "google_project_iam_member" "controller_bucket_lister" {
  project = var.project
  role    = google_project_iam_custom_role.bucket_lister.id
  member  = var.controller_member
}

resource "google_project_iam_member" "controller" {
  for_each = toset(var.controller_roles)

  project = var.project
  role    = each.key
  member  = var.controller_member
}
