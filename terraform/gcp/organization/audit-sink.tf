resource "google_logging_organization_sink" "audit_logs" {
  name             = "audit-log-sink"
  org_id           = data.google_organization.org.org_id
  destination      = "pubsub.googleapis.com/projects/lolcorp/topics/audit-log-ingest"
  include_children = true

  # Each exported event costs a Gemini call in lolcorp's audit-pipeline. Enable only
  # with that pipeline capped, and keep the token-plumbing exclusion.
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

  # Workload-identity token calls; the read exclusion above does not match them.
  exclusions {
    name   = "token-plumbing"
    filter = "LOG_ID(\"cloudaudit.googleapis.com/data_access\") AND protoPayload.methodName=~\"SignBlob|SignJwt|GenerateAccessToken|GenerateIdToken|ExchangeToken\""
  }
}

output "audit_sink_writer_identity" {
  description = "Writer identity for the audit log sink — grant roles/pubsub.publisher on the lolcorp audit-log-ingest topic"
  value       = google_logging_organization_sink.audit_logs.writer_identity
}
