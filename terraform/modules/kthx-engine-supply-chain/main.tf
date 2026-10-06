# The signing key, attestor and grants one artifacts project holds for every vessel. Pass
# signer_key or attestor to bring your own; every grant is an additive *_iam_member.
# GCP never deletes KMS rings and keys, so a destroy orphans them; their names are variables.

locals {
  create_key      = var.signer_key == null
  create_attestor = var.attestor == null

  signer_key_id = local.create_key ? google_kms_crypto_key.signer[0].id : var.signer_key
  attestor_id   = local.create_attestor ? google_binary_authorization_attestor.provenance[0].id : var.attestor

  registry_writers = coalesce(var.registry_writers, var.attester_principals)
}
