resource "google_kms_key_ring" "igm" {
  for_each = var.encrypt_disk ? toset([var.name]) : []
  name     = each.key
  location = var.location
}

resource "google_kms_crypto_key" "igm" {
  for_each = var.encrypt_disk ? toset([var.name]) : []
  name     = each.key
  key_ring = google_kms_key_ring.igm[each.key].self_link

  // 30 days
  rotation_period = "2592000s"

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_kms_key_ring_iam_binding" "igm" {
  for_each    = var.encrypt_disk ? toset([var.name]) : []
  key_ring_id = google_kms_key_ring.igm[each.key].id
  role        = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  members = [
    format("serviceAccount:%s", google_service_account.igm.email),
    format("serviceAccount:service-%s@compute-system.iam.gserviceaccount.com", data.google_project.current.number)
  ]
}
