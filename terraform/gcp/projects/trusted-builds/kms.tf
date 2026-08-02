resource "google_kms_key_ring" "keys" {
  name     = "keys"
  location = local.region
}

resource "google_kms_crypto_key" "signer" {
  name     = "signer"
  key_ring = google_kms_key_ring.keys.id
  purpose  = "ASYMMETRIC_SIGN"

  version_template {
    algorithm = "RSA_SIGN_PKCS1_4096_SHA512"
  }

  lifecycle {
    prevent_destroy = true
  }
}

# `signerVerifier` rather than `signer`, for the one permission between them
# that signing actually needs: `cloudkms.cryptoKeyVersions.viewPublicKey`.
#
# `roles/cloudkms.signer` is `useToSign` and nothing else, which is enough for a
# caller that already knows what it is signing with. Cosign does not: it reads
# the key's public half to learn the algorithm before it can choose a digest,
# and reads it again to verify what it just made. Binary Authorization's
# `sign-and-create` does the same. So the role that sounds exactly right refuses
# every one of them at the first call, and the failure names a permission rather
# than a role.
#
# The `useToVerify` this also grants is not incidental: the same key is the one
# admission re-checks against, on both the registry signature and the
# attestation.
resource "google_kms_crypto_key_iam_binding" "signer" {
  crypto_key_id = google_kms_crypto_key.signer.id
  role          = "roles/cloudkms.signerVerifier"
  members       = local.attester_principals
}