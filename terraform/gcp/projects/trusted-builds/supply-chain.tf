# GCP never deletes a KMS ring or a key, so the ring and key this chain signs
# with are live in the project and in no state file. The module adopts them at
# its own addresses rather than colliding with them on create. Their single
# version is enabled, so the public half reads on the first apply and the
# module README's PENDING_GENERATION retry does not arise — and the public key
# the cluster admission policy pins is the one it already pins.
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

  # Vessel agents only. This project's own Binary Authorization agent reads
  # occurrences on the note because the module composes that grant from the
  # project number; it verifies nothing, so it does not belong here.
  verifier_agents = [local.bluenose_binary_authorization_service_agent]

  registry_readers = [
    local.spindrift_controller_member,
    local.bluenose_binary_authorization_service_agent,
    "serviceAccount:service-${data.google_project.bluenose.number}@serverless-robot-prod.iam.gserviceaccount.com",
  ]
}
