locals {
  spindrift_principal                               = "principal://iam.googleapis.com/projects/629296473058/locations/global/workloadIdentityPools/fml-pool/subject/offsite:system:serviceaccount:spindrift:spindrift"
  spindrift_controller_member                       = data.google_service_account.spindrift_controller.member
  bluenose_binary_authorization_service_agent       = "serviceAccount:service-${data.google_project.bluenose.number}@gcp-sa-binaryauthorization.iam.gserviceaccount.com"
  trusted_builds_binary_authorization_service_agent = "serviceAccount:service-${data.google_project.current.number}@gcp-sa-binaryauthorization.iam.gserviceaccount.com"

  attester_principals = [
    "principalSet://iam.googleapis.com/projects/629296473058/locations/global/workloadIdentityPools/homelab/attribute.repository_owner/jonpulsifer",
    local.spindrift_controller_member,
  ]

  attestor_viewers = concat(local.attester_principals, [
    "serviceAccount:terraform@homelab-ng.iam.gserviceaccount.com",
  ])

  attestation_viewers = [
    local.bluenose_binary_authorization_service_agent,
    local.trusted_builds_binary_authorization_service_agent,
  ]
}
