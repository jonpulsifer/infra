resource "google_service_account" "spindrift_runtime" {
  account_id   = "spindrift-runtime"
  display_name = "Spindrift workload runtime"

  depends_on = [google_project_service.service["iam.googleapis.com"]]
}

resource "google_service_account" "spindrift_controller" {
  account_id   = "spindrift-controller"
  display_name = "Spindrift platform controller"

  depends_on = [google_project_service.service["iam.googleapis.com"]]
}

resource "google_service_account_iam_member" "spindrift_controller_workload_identity" {
  service_account_id = google_service_account.spindrift_controller.name
  role               = "roles/iam.workloadIdentityUser"
  member             = local.spindrift_principal
}

# Signing a V4 storage URL is a separate permission from impersonating.
# Spindrift mints one for every `gs://` source bundle it hands a hosted build
# route, and signs it through IAM's `signBlob` as the federated principal —
# before impersonation — so the string-to-sign never needs a private key.
# `roles/iam.workloadIdentityUser` carries `iam.serviceAccounts.getAccessToken`
# but not `iam.serviceAccounts.signBlob`, so impersonation succeeds while every
# signature is refused. `roles/iam.serviceAccountTokenCreator` is the role that
# carries both.
resource "google_service_account_iam_member" "spindrift_controller_token_creator" {
  service_account_id = google_service_account.spindrift_controller.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = local.spindrift_principal
}

# Attaching an identity to something is a separate permission from creating the
# something. The controller writes both a Cloud Run revision and a Cloud
# Scheduler job that authenticate as the runtime account, and neither call is
# admitted without `iam.serviceAccounts.actAs` on it.
resource "google_service_account_iam_member" "spindrift_act_as_runtime" {
  service_account_id = google_service_account.spindrift_runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = google_service_account.spindrift_controller.member
}

locals {
  spindrift_project_roles = toset([
    "roles/cloudsql.admin",
    # A Cloud Run Job carries no cron expression, so a scheduled Component is a
    # Cloud Scheduler job the controller keeps beside the Job.
    # `roles/run.admin` covers `run.jobs.*` and nothing scheduler-shaped, and
    # this is the narrowest predefined role covering the three verbs the adapter
    # calls — `cloudscheduler.jobs.create`, `.update` and `.delete`. Neither
    # narrower role reaches them: `roles/cloudscheduler.viewer` only reads, and
    # `roles/cloudscheduler.jobRunner` only forces a run of a job somebody else
    # created. Nothing wider, either: an editor-shaped role would carry every
    # other API in the project along with it.
    "roles/cloudscheduler.admin",
    "roles/compute.networkUser",
    "roles/firebasehosting.admin",
    "roles/iap.admin",
    "roles/redis.admin",
    "roles/run.admin",
    "roles/secretmanager.admin",
    "roles/serviceusage.serviceUsageConsumer",
  ])
}

# `roles/run.invoker` is deliberately absent from the list above, and the
# absence is the design rather than a gap. A scheduled Component's Cloud
# Scheduler job calls `jobs.run` under an OIDC identity that is granted the
# role **on the one Job it fires**, by the controller, at deploy time:
# `apps/spindrift/src/adapters/deploy/cloudrun/scheduler.ts:112-124` sets the
# whole policy on that resource and says why nothing wider reaches it.
# Granting it here instead would hand the controller the right to invoke every
# Cloud Run resource in the project, for the life of the project, to save a
# per-Job call it already makes.

resource "google_project_iam_member" "spindrift" {
  for_each = local.spindrift_project_roles

  project = local.project
  role    = each.key
  member  = google_service_account.spindrift_controller.member
}
