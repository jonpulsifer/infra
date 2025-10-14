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

resource "google_kms_crypto_key_iam_binding" "signer" {
  crypto_key_id = google_kms_crypto_key.signer.id
  role          = "roles/cloudkms.signer"
  members = local.attester_principals
}