module "firebase_project_policies" {
  source  = "../../../modules/firebase-project-policies"
  project = local.project
}
