module "supply_chain" {
  source = "../../../modules/spindrift-supply-chain"

  project    = local.project
  location   = local.region
  repository = google_artifact_registry_repository.images.repository_id

  # A ring named `keys` holding a key named `signer` is live in this project
  # and in no state file, its only version DESTROY_SCHEDULED. GCP never
  # deletes a ring or a key, so those two names are spent: creating them
  # collides, and adopting them yields a key whose only version cannot be
  # read. The module's other branch is these names — it creates the ring, the
  # key, and a first version, and the chain signs with material that belongs
  # to this installation.
  key_ring_name   = "spindrift"
  signer_key_name = "signer"

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
