# The bring-your-own posture: an existing key and attestor come in as ids,
# the module creates neither, and only the grants that can attach to what was
# provided are wired. The README states what this caller arranges where the
# key and attestor live.

module "supply_chain" {
  source = "../.."

  project           = "artifacts-project"
  location          = "northamerica-northeast1"
  repository        = "i"
  controller_member = "serviceAccount:spindrift-controller@home-vessel.iam.gserviceaccount.com"

  attester_principals = [
    "serviceAccount:spindrift-controller@home-vessel.iam.gserviceaccount.com",
  ]

  signer_key = "projects/keys-project/locations/northamerica-northeast1/keyRings/keys/cryptoKeys/signer"
  attestor   = "projects/attestor-project/attestors/provenance"
}

output "attestor" {
  value = module.supply_chain.attestor
}

output "signer_uri" {
  value = module.supply_chain.signer_uri
}
