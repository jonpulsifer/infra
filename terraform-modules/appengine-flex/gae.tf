resource "google_app_engine_application" "app" {
  project        = var.project
  location_id    = var.location
  auth_domain    = var.auth_domain
  serving_status = var.serving_status
  lifecycle {
    ignore_changes = [
      iap
    ]
  }
}

resource "google_app_engine_firewall_rule" "app" {
  project      = google_app_engine_application.app.project
  for_each     = var.firewall_rules
  action       = each.value.action
  source_range = each.value.source_range
  description  = each.key
  priority     = each.value.priority
}

resource "google_app_engine_domain_mapping" "app" {
  for_each          = var.domain_names
  domain_name       = each.key
  override_strategy = "STRICT"
  ssl_settings {
    ssl_management_type = "AUTOMATIC"
  }
}
