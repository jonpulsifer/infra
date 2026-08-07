# One project made a Spindrift vessel: the APIs it serves, the identities that
# act and run inside it, and the admission policy every container must pass.
# The home-vessel-only pieces — the controller service account itself, its
# federation bindings, the source bucket, Secret Manager read paths for
# clusters — stay in the home vessel's root; this module is only the shape
# every vessel repeats.
#
# ponytail: `services` and `controller_roles` are required inputs rather than
# defaults, and the calling root should declare them as locals in its
# services.tf and iam.tf. Spindrift's remediation generator appends flat
# resource stanzas to those files and dedupes by grepping them for the quoted
# service/role strings — a default set buried here would be invisible to it,
# and a generated stanza would then manage an enablement this module already
# owns.

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

# Attaching an identity to something is a separate permission from creating the
# something. The controller writes both a Cloud Run revision and a Cloud
# Scheduler job that authenticate as the runtime account, and neither call is
# admitted without `iam.serviceAccounts.actAs` on it.
resource "google_service_account_iam_member" "controller_acts_as_runtime" {
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = var.controller_member
}

# Cloud Run resolves a revision's secret environment variables as the runtime
# service account. Spindrift owns the dynamically named secrets in the vessel,
# so the runtime needs a project-wide read path that includes future secrets.
resource "google_project_iam_member" "runtime_secret_reader" {
  project = var.project
  role    = "roles/secretmanager.secretAccessor"
  member  = google_service_account.runtime.member
}

# Connect-time discovery offers the vessel's buckets as staging candidates,
# and the home vessel's SOURCE_BUCKET probe asks the same question. Both are
# `storage.buckets.list` and nothing else — object access stays per-bucket,
# and no predefined role carries the list permission without dragging object
# reads along, so this is a custom role rather than `roles/viewer`.
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
