resource "google_service_account" "firebase" {
  account_id   = "firebase"
  display_name = "firebase"
}

resource "google_service_account" "firebase_client_emulators" {
  account_id   = "emulators"
  display_name = "firebase client emulators"
}
