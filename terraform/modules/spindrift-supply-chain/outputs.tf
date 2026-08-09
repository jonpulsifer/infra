output "attestor" {
  description = "Binary Authorization attestor id (projects/*/attestors/*) — what terraform/modules/spindrift-vessel's attestor variable takes"
  value       = local.attestor_id
}

output "signer_key" {
  description = "Signer crypto key resource id (projects/*/locations/*/keyRings/*/cryptoKeys/*)"
  value       = local.signer_key_id
}

output "signer_uri" {
  description = "The key as the installation manifest's supplyChain.signer names it: gcpkms:// prefixed to the key's resource id"
  value       = "gcpkms://${local.signer_key_id}"
}

output "signer_key_version_uri" {
  description = "Latest key version as //cloudkms.googleapis.com/v1/… — the public key id the attestor registers and sign-and-create stamps. Null with a bring-your-own attestor, which registers its own."
  value       = local.create_attestor ? "//cloudkms.googleapis.com/v1/${data.google_kms_crypto_key_latest_version.signer[0].name}" : null
}

output "note" {
  description = "Container-analysis note id (projects/*/notes/*). Null with a bring-your-own attestor."
  value       = local.create_attestor ? google_container_analysis_note.provenance[0].id : null
}

output "registry_namespace" {
  description = "Artifact Registry namespace Spindrift publishes to — supplyChain.registry material. A namespace, not a repository: core appends {app}/{component}."
  value       = "${var.location}-docker.pkg.dev/${var.project}/${var.repository}"
}
