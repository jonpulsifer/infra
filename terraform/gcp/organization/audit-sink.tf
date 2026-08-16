resource "google_logging_organization_sink" "audit_logs" {
  name             = "audit-log-sink"
  org_id           = data.google_organization.org.org_id
  destination      = "pubsub.googleapis.com/projects/lolcorp/topics/audit-log-ingest"
  include_children = true

  # Off. Every exported event costs a Gemini call in lolcorp's audit-pipeline,
  # and a Spindrift dispatch retry loop turned that into ~85k calls/day
  # (2026-08-14/15) — straight through the billing budgets. Re-enable only
  # with the pipeline capped (pre-LLM filter or daily budget), and keep the
  # token-plumbing exclusion below when you do.
  disabled = true

  filter = <<-EOT
    LOG_ID("cloudaudit.googleapis.com/activity") OR
    LOG_ID("cloudaudit.googleapis.com/data_access") OR
    LOG_ID("cloudaudit.googleapis.com/system_event") OR
    LOG_ID("cloudaudit.googleapis.com/policy")
  EOT

  exclusions {
    name   = "health-checkers"
    filter = "protoPayload.requestMetadata.callerSuppliedUserAgent=~\"GoogleHC|kube-probe|Googlebot\""
  }

  exclusions {
    name   = "lb-2xx-pings"
    filter = "resource.type=\"http_load_balancer\" AND httpRequest.status>=200 AND httpRequest.status<300"
  }

  exclusions {
    name   = "high-volume-reads"
    filter = "LOG_ID(\"cloudaudit.googleapis.com/data_access\") AND protoPayload.methodName=~\"Get|List|Watch\""
  }

  # Workload-identity token plumbing. Every federated call from the homelab
  # mints STS exchanges, impersonations, and signed-URL SignBlobs — none of
  # which match the read exclusion above, so a single busy loop can export
  # tens of thousands of events a day that describe nothing but our own
  # machinery authenticating to itself.
  exclusions {
    name   = "token-plumbing"
    filter = "LOG_ID(\"cloudaudit.googleapis.com/data_access\") AND protoPayload.methodName=~\"SignBlob|SignJwt|GenerateAccessToken|GenerateIdToken|ExchangeToken\""
  }
}

output "audit_sink_writer_identity" {
  description = "Writer identity for the audit log sink — grant roles/pubsub.publisher on the lolcorp audit-log-ingest topic"
  value       = google_logging_organization_sink.audit_logs.writer_identity
}
