# Mixed posture two: the module creates the key, admission checks against an
# attestor that lives elsewhere. The registration the caller performs on that
# attestor takes exactly these three outputs — the version URI as the public
# key id, the PEM, and the algorithm.

module "supply_chain" {
  source = "../.."

  project           = "artifacts-project"
  location          = "northamerica-northeast1"
  repository        = "i"
  controller_member = "serviceAccount:spindrift-controller@home-vessel.iam.gserviceaccount.com"

  attester_principals = [
    "serviceAccount:spindrift-controller@home-vessel.iam.gserviceaccount.com",
  ]

  attestor = "projects/attestor-project/attestors/provenance"
}

output "registration" {
  value = {
    public_key_id = module.supply_chain.signer_key_version_uri
    pem           = module.supply_chain.signer_public_key_pem
    algorithm     = module.supply_chain.signer_public_key_algorithm
  }
}
