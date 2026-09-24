data "google_project" "bluenose" {
  project_id = "bluenose"
}

locals {
  spindrift_vessel_project                    = "bluenose"
  spindrift_controller_member                 = "serviceAccount:spindrift-controller@${local.spindrift_vessel_project}.iam.gserviceaccount.com"
  bluenose_binary_authorization_service_agent = "serviceAccount:service-${data.google_project.bluenose.number}@gcp-sa-binaryauthorization.iam.gserviceaccount.com"

  cloud_build_worker_member = "serviceAccount:${data.google_project.current.number}@cloudbuild.gserviceaccount.com"

  # Named by the reusable workflow, so every connected repository's caller of it matches.
  spindrift_build_workflow_principal = "principalSet://iam.googleapis.com/projects/629296473058/locations/global/workloadIdentityPools/homelab/attribute.workflow/jonpulsifer/infra/.github/workflows/spindrift-build.yml@refs/heads/main"

  # One signer per build route. The Cloud Build worker attests as a step of the build it pushes.
  attester_principals = [
    local.spindrift_build_workflow_principal,
    # Remove once a build on main has signed under the workflow principal.
    "principalSet://iam.googleapis.com/projects/629296473058/locations/global/workloadIdentityPools/homelab/attribute.repository_owner/jonpulsifer",
    local.spindrift_controller_member,
    local.cloud_build_worker_member,
  ]

  attestor_viewers = concat(local.attester_principals, [
    "serviceAccount:terraform@homelab-ng.iam.gserviceaccount.com",
  ])
}
