locals {
  # The ConfigMap Flux substitutes into folly apps; the precondition checks against it.
  folly_settings = yamldecode(file("../../../../clusters/folly/config/cluster-settings.yaml"))
}

# Reserved inside the DHCP pool; the controller excludes reserved addresses from it.
# No network_id: the controller rejects a network override on Management, the default.
resource "unifi_client" "cathy" {
  mac      = local.clients.voip.cathy.mac
  name     = local.clients.voip.cathy.name
  fixed_ip = cidrhost(local.fml_cidr, local.clients.voip.cathy.ip)
  note     = "terraform managed - ${local.clients.voip.cathy.model} SIP handset (${local.clients.voip.cathy.hostname})"

  # The controller already knows this MAC.
  allow_existing         = true
  skip_forget_on_destroy = true

  # The PBX NetworkPolicy lets it ring only CATHY_IP; a mismatch leaves a handset
  # that registers and never rings.
  lifecycle {
    precondition {
      condition     = cidrhost(local.fml_cidr, local.clients.voip.cathy.ip) == local.folly_settings.data.CATHY_IP
      error_message = "clusters/folly/config/cluster-settings.yaml's CATHY_IP disagrees with the clients.yaml octet for cathy."
    }
  }
}
