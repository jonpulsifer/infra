# APIs enabled on this vessel, applied through the spindrift-vessel module.
# Declared in this file rather than beside the module call: Spindrift's
# generated remediation stanzas append `google_project_service` resources to a
# vessel root's services.tf and dedupe by grepping it for the quoted service
# string, so the list has to live where the generator looks.
locals {
  vessel_services = [
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
  ]
}
