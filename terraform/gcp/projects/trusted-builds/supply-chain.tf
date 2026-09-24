# GCP never deletes a KMS key ring or key, so this root imports the existing signer into the module.
import {
  to = module.supply_chain.google_kms_key_ring.keys[0]
  id = "projects/trusted-builds/locations/northamerica-northeast1/keyRings/keys"
}

import {
  to = module.supply_chain.google_kms_crypto_key.signer[0]
  id = "projects/trusted-builds/locations/northamerica-northeast1/keyRings/keys/cryptoKeys/signer"
}

module "supply_chain" {
  source = "../../../modules/spindrift-supply-chain"

  project    = local.project
  location   = local.region
  repository = google_artifact_registry_repository.images.repository_id

  controller_member = local.spindrift_controller_member

  attester_principals = local.attester_principals
  attestor_viewers    = local.attestor_viewers

  # Vessel agents only; the module grants this project's own agent from its project number.
  verifier_agents = [local.bluenose_binary_authorization_service_agent]

  registry_readers = [
    local.spindrift_controller_member,
    local.bluenose_binary_authorization_service_agent,
    "serviceAccount:service-${data.google_project.bluenose.number}@serverless-robot-prod.iam.gserviceaccount.com",
  ]
}
