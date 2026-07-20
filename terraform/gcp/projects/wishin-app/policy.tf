module "firebase_project_policies" {
  source  = "../../../modules/firebase-project-policies"
  project = local.project
}

moved {
  from = google_org_policy_policy.allow_service_accounts
  to   = module.firebase_project_policies.google_org_policy_policy.allow_service_accounts
}

moved {
  from = google_org_policy_policy.allow_service_account_keys
  to   = module.firebase_project_policies.google_org_policy_policy.allow_service_account_keys
}

moved {
  from = google_org_policy_policy.allowed_storage_retention_policy_seconds
  to   = module.firebase_project_policies.google_org_policy_policy.allowed_storage_retention_policy_seconds
}
