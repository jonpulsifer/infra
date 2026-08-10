# GCP never deletes a KMS ring or key. The hand-rolled predecessor's
# `google_kms_key_ring.keys` and `google_kms_crypto_key.signer` were dropped
# from state by commit 396bc1c16 (PR #1947), but the ring and the key are
# still live in this project, orphaned. This rebuild adopts them into the
# module's addresses instead of the apply colliding with an "already exists"
# error — and because the key is the one from its previous life, its version
# is already generated, so the module README's PENDING_GENERATION
# first-apply retry does not apply here.
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
