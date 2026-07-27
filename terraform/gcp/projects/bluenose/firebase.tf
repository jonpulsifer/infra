module "firebase_project_policies" {
  source  = "../../../modules/firebase-project-policies"
  project = local.project
}

resource "google_firebase_project" "spindrift" {
  provider = google-beta
  project  = local.project

  depends_on = [
    google_project_service.service["firebase.googleapis.com"],
    module.firebase_project_policies,
  ]
}
