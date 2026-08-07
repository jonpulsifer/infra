resource "google_project_service" "service" {
  for_each = toset([
    "artifactregistry.googleapis.com",
    "binaryauthorization.googleapis.com",
    # The build submit targets trusted-builds, but the controller's federated
    # token bills its quota here — and GCP refuses a call whose consumer
    # project has not enabled the API, whatever project the URL names.
    "cloudbuild.googleapis.com",
    # The signer keys live in trusted-builds, but the controller's federated
    # token bills its quota here — same rule as cloudbuild above. Without this,
    # the home vessel's SIGNER_KEY probe answers SERVICE_DISABLED for a keyring
    # that exists and is listable, because the refusal names the consumer.
    "cloudkms.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    # A Cloud Run Job holds no cron expression, so a Component that declares a
    # schedule is a Cloud Scheduler job calling `jobs.run` in front of it.
    # Enabling this also creates the Cloud Scheduler service agent, which is
    # what mints the token that call carries.
    "cloudscheduler.googleapis.com",
    "compute.googleapis.com",
    "firebase.googleapis.com",
    "firebasehosting.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "iap.googleapis.com",
    "redis.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "servicenetworking.googleapis.com",
    "serviceusage.googleapis.com",
    "sqladmin.googleapis.com",
    "storage.googleapis.com",
  ])

  project            = local.project
  service            = each.key
  disable_on_destroy = false
}
