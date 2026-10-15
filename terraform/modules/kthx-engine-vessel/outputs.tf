output "runtime_service_account" {
  description = "The runtime service account revisions and jobs run as"
  value       = google_service_account.runtime
}

output "bucket_lister_role_id" {
  description = "Id of the custom role that lists the project's buckets"
  value       = google_project_iam_custom_role.bucket_lister.id
}
