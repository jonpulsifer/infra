resource "google_firebase_project" "wishin_app" {
  provider = google-beta
  project  = local.project
}
