output "runtime_service_account" {
  description = "The runtime service account revisions and jobs run as"
  value       = google_service_account.runtime
}
