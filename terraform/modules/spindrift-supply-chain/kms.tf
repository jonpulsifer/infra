resource "google_kms_key_ring" "keys" {
  count = local.create_key ? 1 : 0

  project  = var.project
  name     = var.key_ring_name
  location = var.location
}

resource "google_kms_crypto_key" "signer" {
  count = local.create_key ? 1 : 0

  name     = var.signer_key_name
  key_ring = google_kms_key_ring.keys[0].id
  purpose  = "ASYMMETRIC_SIGN"

  version_template {
    algorithm = "RSA_SIGN_PKCS1_4096_SHA512"
  }
}

# Not roles/cloudkms.signer: cosign and sign-and-create read the public key before
# signing, which needs cloudkms.cryptoKeyVersions.viewPublicKey.
resource "google_kms_crypto_key_iam_member" "signer" {
  for_each = toset(var.attester_principals)

  crypto_key_id = local.signer_key_id
  role          = "roles/cloudkms.signerVerifier"
  member        = each.key
}

# cosign reads the key (cloudkms.cryptoKeys.get) for its hash, and the attestation step lists versions;
# signerVerifier grants neither. cloudkms.viewer adds metadata reads only.
resource "google_kms_crypto_key_iam_member" "signer_metadata" {
  for_each = toset(var.attester_principals)

  crypto_key_id = local.signer_key_id
  role          = "roles/cloudkms.viewer"
  member        = each.key
}

# The SIGNER_KEY probe lists key rings, which needs a project-scope grant. With a key
# brought from another project, the caller mirrors this grant there.
resource "google_project_iam_member" "controller_probe_viewer" {
  project = var.project
  role    = "roles/cloudkms.viewer"
  member  = var.controller_member
}
