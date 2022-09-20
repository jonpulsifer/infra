resource "google_kms_key_ring" "vault" {
  name     = "vault"
  location = local.region
}

resource "google_kms_crypto_key" "vault" {
  name     = "vault"
  key_ring = google_kms_key_ring.vault.id

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_kms_crypto_key_iam_member" "vault" {
  crypto_key_id = google_kms_crypto_key.vault.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = format("serviceAccount:%s", google_service_account.vault.email)
}

resource "google_kms_key_ring" "storage" {
  name     = "storage"
  location = local.region
}

resource "google_kms_crypto_key" "storage" {
  name     = "storage"
  key_ring = google_kms_key_ring.storage.id

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_kms_crypto_key_iam_member" "storage" {
  crypto_key_id = google_kms_crypto_key.storage.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "group:cloud@pulsifer.ca"
}
