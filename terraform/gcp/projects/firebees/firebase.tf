resource "google_firebase_project" "firebees" {
  provider = google-beta
  project  = local.project
}
