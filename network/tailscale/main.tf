# ---------------------------------------------------------------------------
# Tailscale tailnet-wide resources
# ---------------------------------------------------------------------------

# Touch to trigger Atlantis plan on policy.hujson changes.
# Re-applies the offsite k8s subnet-router autoApprovers that merged in #911
# without an apply, leaving offsite-k8s-lan-router routes stuck pending.
resource "tailscale_acl" "this" {
  acl = file("${path.module}/policy.hujson")
}

resource "tailscale_dns_configuration" "this" {
  magic_dns = true

  nameservers {
    address = "1.1.1.1"
  }
}

resource "tailscale_tailnet_settings" "this" {
  acls_externally_managed_on                  = false
  devices_approval_on                         = true
  devices_auto_updates_on                     = true
  devices_key_duration_days                   = 180
  https_enabled                               = true
  network_flow_logging_on                     = false
  posture_identity_collection_on              = true
  regional_routing_on                         = false
  users_approval_on                           = true
  users_role_allowed_to_join_external_tailnet = "admin"
}

resource "tailscale_contacts" "this" {
  account {
    email = "jonathan@pulsifer.ca"
  }

  support {
    email = "jonathan@pulsifer.ca"
  }

  security {
    email = "jonathan@pulsifer.ca"
  }
}
