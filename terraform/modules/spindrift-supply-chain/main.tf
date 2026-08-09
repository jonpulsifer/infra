# The supply chain one artifacts project holds for every Spindrift vessel:
# the KMS key that signs, the Binary Authorization attestor admission checks
# against, and the grants that let the build routes push, sign, attest, and
# be verified. The Artifact Registry repository itself is a caller input —
# it may be shared with non-Spindrift consumers, so it stays declared where
# it lives.
#
# Two postures, one module. With defaults the module provisions the whole
# chain. An installation bringing its own key or attestor passes `signer_key`
# / `attestor` instead: the module then creates neither but still attaches
# every grant that coherently can attach to the provided resource. Every
# grant is an additive `*_iam_member` — the module never owns the full policy
# on the key, attestor, or note, so a bring-your-own resource is never
# stomped.
#
# Nothing here carries prevent_destroy: this module is the rebuild surface,
# and teardown-friendliness is a feature. GCP itself refuses to delete KMS
# rings and keys — a destroy orphans them, which is why the ring and key
# names are variables.

locals {
  create_key      = var.signer_key == null
  create_attestor = var.attestor == null

  signer_key_id = local.create_key ? google_kms_crypto_key.signer[0].id : var.signer_key
  attestor_id   = local.create_attestor ? google_binary_authorization_attestor.provenance[0].id : var.attestor

  registry_writers = coalesce(var.registry_writers, var.attester_principals)
}
