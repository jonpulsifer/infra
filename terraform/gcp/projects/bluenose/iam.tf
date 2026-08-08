# The identities every vessel repeats — the runtime service account, the
# controller's project roles, the bucket-lister custom role — live in the
# spindrift-vessel module (vessel.tf). What stays here is home-vessel-only:
# the controller service account itself, its federation bindings, and the
# clusters' read path into this vessel's Secret Manager.

resource "google_service_account" "spindrift_controller" {
  account_id   = "spindrift-controller"
  display_name = "Spindrift platform controller"

  depends_on = [module.vessel]
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

# The clean-installation acceptance environment federates as this same account.
#
# The pool's subject is the cluster, the namespace and the service account, so a
# second installation is a second subject however identical its deployment is —
# it gets no access at all without these two, which is the shape working
# correctly rather than an obstacle.
#
# Bound to the existing account rather than given its own. §14 puts identity
# provisioning in this repository's Terraform and not in the product, so a
# second account would exercise these files rather than anything Spindrift
# does, at the price of duplicating every project role, both bucket grants and
# the signer for an environment whose purpose is to be deleted. What it costs
# is stated where the installation is declared: the acceptance installation can
# reach everything the running one can.
#
# Deleting `clusters/offsite/apps/spindrift-acceptance` is what retires these.
resource "google_service_account_iam_member" "spindrift_acceptance_workload_identity" {
  service_account_id = google_service_account.spindrift_controller.name
  role               = "roles/iam.workloadIdentityUser"
  member             = local.spindrift_acceptance_principal
}

resource "google_service_account_iam_member" "spindrift_acceptance_token_creator" {
  service_account_id = google_service_account.spindrift_controller.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = local.spindrift_acceptance_principal
}

# The roles the controller holds on this vessel. Declared in this file rather
# than beside the module call for the reason services.tf gives: Spindrift's
# generated remediation stanzas append `google_project_iam_member` resources
# to a vessel root's iam.tf and dedupe by grepping it for the quoted role
# string.
locals {
  spindrift_project_roles = [
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
  ]
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

# The delivery half of the same store. Spindrift writes a config item here with
# `roles/secretmanager.admin` above; the Target the Component runs on fetches it
# back, and for a Kubernetes Target that fetch is external-secrets, not
# Spindrift. So each cluster's operator needs its own read path into this
# vessel's Secret Manager, or a Component placed on a cluster resolves nothing.
#
# `roles/secretmanager.secretAccessor` and no wider: the chart renders an
# `ExternalSecret` naming a secret id and a pinned version number, which is
# `secretmanager.versions.access` alone. Nothing here lists, creates or
# describes — `roles/secretmanager.viewer` would only add metadata reads nobody
# makes.
#
# The principal is federated directly rather than through a service account.
# There is nothing for one to carry: the grant is a single read role on a single
# project, so an impersonated account would be an extra identity holding exactly
# the permissions the principal already holds. The Kubernetes service account
# each subject names is declared in `clusters/base/platform/gcp-secret-manager`,
# and the per-cluster provider that mints its token in
# terraform/gcp/projects/homelab-ng/workload-identity.tf.
locals {
  cluster_secret_readers = toset(["folly", "offsite"])
}

resource "google_project_iam_member" "cluster_secret_reader" {
  for_each = local.cluster_secret_readers

  project = local.project
  role    = "roles/secretmanager.secretAccessor"
  member  = "principal://${local.fml_pool}/subject/${each.key}:system:serviceaccount:external-secrets:gcp-secret-manager"
}
