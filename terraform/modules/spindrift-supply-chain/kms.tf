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

# `signerVerifier` rather than `signer`, for the one permission between them
# that signing actually needs: `cloudkms.cryptoKeyVersions.viewPublicKey`.
# Cosign reads the key's public half to learn the algorithm before it can
# choose a digest, and reads it again to verify what it just made; Binary
# Authorization's `sign-and-create` does the same. `roles/cloudkms.signer`
# refuses every one of them at the first call. The `useToVerify` this also
# grants is not incidental: the same key is the one admission re-checks
# against, on both the registry signature and the attestation.
resource "google_kms_crypto_key_iam_member" "signer" {
  for_each = toset(var.attester_principals)

  crypto_key_id = local.signer_key_id
  role          = "roles/cloudkms.signerVerifier"
  member        = each.key
}

# The third permission signing needs: `cloudkms.cryptoKeys.get`. Before it
# can sign, cosign reads the key itself to learn its default hash function —
# nothing on the command line says `RSA_SIGN_PKCS1_4096_SHA512`.
# `signerVerifier` grants use of the *versions* and sight of their public
# halves, not `get` on the key they hang off. `roles/cloudkms.viewer` is
# metadata only, so this adds reading and no capability; it also makes
# `cryptoKeyVersions.list` answer, which is how the attestation step finds
# the enabled version.
resource "google_kms_crypto_key_iam_member" "signer_metadata" {
  for_each = toset(var.attester_principals)

  crypto_key_id = local.signer_key_id
  role          = "roles/cloudkms.viewer"
  member        = each.key
}

# The home vessel's SIGNER_KEY probe asks a different question from signing:
# not "may I use this key" but "does a key with the signing purpose exist
# here" — and it starts by enumerating the rings, which is
# `cloudkms.keyRings.list` at project scope. A ring-scoped grant answers the
# second call and not the first, so the viewer sits on the project. With a
# bring-your-own key in another project, the caller mirrors this grant there
# or the probe reports no key.
resource "google_project_iam_member" "controller_probe_viewer" {
  project = var.project
  role    = "roles/cloudkms.viewer"
  member  = var.controller_member
}
