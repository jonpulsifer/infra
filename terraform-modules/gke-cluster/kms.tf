resource "google_kms_key_ring" "gke" {
  name     = var.name
  location = var.location
}

resource "google_kms_crypto_key" "gke" {
  name     = var.name
  key_ring = google_kms_key_ring.gke.id

  // 30 days
  rotation_period = "2592000s"
}

resource "google_kms_key_ring_iam_member" "gke" {
  key_ring_id = google_kms_key_ring.gke.id
  role        = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member      = "serviceAccount:service-${data.google_project.current.number}@container-engine-robot.iam.gserviceaccount.com"
}
