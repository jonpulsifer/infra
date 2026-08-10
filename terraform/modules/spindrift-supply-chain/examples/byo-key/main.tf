# Mixed posture one: an existing key signs, the module still provisions the
# attestor and note and registers the provided key's latest version on them.
# The identity running the plan needs `roles/cloudkms.viewer` on the key.

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
}

output "attestor" {
  value = module.supply_chain.attestor
}
