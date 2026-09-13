# ---------------------------------------------------------------------------
# Tailscale tailnet-wide resources
# ---------------------------------------------------------------------------

# The whole tailnet policy is one file and one resource. Atlantis autoplans it
# because ATLANTIS_AUTOPLAN_FILE_LIST names "terraform/**/*.hujson"; a policy
# change with no .tf beside it plans nothing otherwise, and a green PR that
# planned 0/0 projects looks exactly like a green PR that applied.
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
