data "google_project" "bluenose" {
  project_id = "bluenose"
}

locals {
  spindrift_vessel_project                    = "bluenose"
  spindrift_controller_member                 = "serviceAccount:spindrift-controller@${local.spindrift_vessel_project}.iam.gserviceaccount.com"
  bluenose_binary_authorization_service_agent = "serviceAccount:service-${data.google_project.bluenose.number}@gcp-sa-binaryauthorization.iam.gserviceaccount.com"

  cloud_build_worker_member = "serviceAccount:${data.google_project.current.number}@cloudbuild.gserviceaccount.com"

  # Everything that signs with the attestor's key. Each gets four grants —
  # `signerVerifier` and `viewer` on the key, `occurrences.editor` on the
  # project, `notes.attacher` on the note — because attesting is two
  # permissions in two places and holding one of them is holding neither.
  #
  # The workflow run, the controller, and the cloud build worker: one per build
  # route that can reach a Target enforcing a Binary Authorization policy. The
  # worker is here because the attestation runs as a step of the build it
  # attests (`adapters/build/cloud-build.ts`), which is the only thing in that
  # route holding the digest at the moment it is pushed.
  #
  # The workflow run is named by the reusable workflow it executes, not by the
  # repository it runs in: a connected repository's caller runs that workflow
  # on its own Actions minutes, and the pool admits it on the same claim
  # (terraform/gcp/projects/homelab-ng/workload-identity.tf). The
  # repository-owner principal beside it is the grant every hosted build has
  # signed under so far; it goes once one build on `main` has signed under the
  # workflow principal, which is the first proof of what the claim reads as for
  # this repository's own `uses: ./…` caller.
  spindrift_build_workflow_principal = "principalSet://iam.googleapis.com/projects/629296473058/locations/global/workloadIdentityPools/homelab/attribute.workflow/jonpulsifer/infra/.github/workflows/spindrift-build.yml@refs/heads/main"

  attester_principals = [
    local.spindrift_build_workflow_principal,
    "principalSet://iam.googleapis.com/projects/629296473058/locations/global/workloadIdentityPools/homelab/attribute.repository_owner/jonpulsifer",
    local.spindrift_controller_member,
    local.cloud_build_worker_member,
  ]

  attestor_viewers = concat(local.attester_principals, [
    "serviceAccount:terraform@homelab-ng.iam.gserviceaccount.com",
  ])
}
