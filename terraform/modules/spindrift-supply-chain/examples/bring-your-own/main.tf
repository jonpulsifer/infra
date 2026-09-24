# Bring-your-own posture: the module creates neither key nor attestor and attaches only the
# grants that fit them. The README lists what the caller arranges where they live.

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
