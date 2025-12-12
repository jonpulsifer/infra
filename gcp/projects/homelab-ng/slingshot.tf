locals {
  slingshot_subject = "owner:jonpulsifers-projects:project:slingshot:environment:production"
  slingshot_environments = ["production", "development"]
  slingshot_subjects = [for environment in local.slingshot_environments : "owner:jonpulsifers-projects:project:slingshot:environment:${environment}"]
  slingshot_principals = [for subject in local.slingshot_subjects : "principal://iam.googleapis.com/${google_iam_workload_identity_pool.homelab.name}/subject/${subject}"]
}