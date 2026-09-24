# Default posture: the module provisions the key, attestor, note and every grant.
# Values are placeholders.

module "supply_chain" {
  source = "../.."

  project           = "artifacts-project"
  location          = "northamerica-northeast1"
  repository        = "i"
  controller_member = "serviceAccount:spindrift-controller@home-vessel.iam.gserviceaccount.com"

  attester_principals = [
    "principalSet://iam.googleapis.com/projects/000000000000/locations/global/workloadIdentityPools/pool/attribute.repository_owner/owner",
    "serviceAccount:spindrift-controller@home-vessel.iam.gserviceaccount.com",
    "serviceAccount:000000000000@cloudbuild.gserviceaccount.com",
  ]

  attestor_viewers = ["serviceAccount:terraform@admin-project.iam.gserviceaccount.com"]

  # Empty on first bootstrap; a vessel's agent joins once that vessel enables the API.
  verifier_agents = ["serviceAccount:service-000000000000@gcp-sa-binaryauthorization.iam.gserviceaccount.com"]

  registry_readers = [
    "serviceAccount:spindrift-controller@home-vessel.iam.gserviceaccount.com",
    "serviceAccount:service-000000000000@gcp-sa-binaryauthorization.iam.gserviceaccount.com",
    "serviceAccount:service-000000000000@serverless-robot-prod.iam.gserviceaccount.com",
  ]
}

# What the vessel module and the installation manifest take from here.
output "attestor" {
  value = module.supply_chain.attestor
}

output "supply_chain_manifest_block" {
  value = {
    signer   = module.supply_chain.signer_uri
    registry = module.supply_chain.registry_namespace
  }
}
