locals {
  # The Flux ConfigMap the folly apps Kustomization substitutes from. Read as
  # YAML rather than restated, so the precondition below compares this root
  # against the file the cluster actually reconciles.
  folly_settings = yamldecode(file("../../../../clusters/folly/config/cluster-settings.yaml"))
}

# The Cisco SPA504G in Jon's office. It registers over SIP and is the one
# handset on this network, so anything that watches or talks to it — a
# Prometheus target, a syslog receiver, a PBX ACL — needs an address that
# outlives a DHCP lease.
#
# .151 is inside Management's DHCP pool (.100-.254). The controller excludes a
# reserved address from the pool, and the phone already holds this lease, so
# reserving it in place costs nothing; moving it to a low octet would cost a
# renew on a device that answers the phone.
#
# No network_id: Management is the default network, and the provider turns one
# into a virtual-network override the controller rejects. See the comment on
# `atomic` in windows-hosts.tf.
resource "unifi_client" "cathy" {
  mac      = local.clients.voip.cathy.mac
  name     = local.clients.voip.cathy.name
  fixed_ip = cidrhost(local.fml_cidr, local.clients.voip.cathy.ip)
  note     = "terraform managed - ${local.clients.voip.cathy.model} SIP handset (${local.clients.voip.cathy.hostname})"

  # The controller already knows this MAC by name, so the resource adopts the
  # existing client instead of failing on one it did not create.
  allow_existing         = true
  skip_forget_on_destroy = true

  # The folly PBX's NetworkPolicy names this address as the one LAN host it may
  # ring, and Flux substitutes it from the cluster-settings ConfigMap — which
  # cannot read this file. Two copies of a network fact drift silently, and the
  # symptom would be a handset that registers and never rings. Fail the plan
  # instead, the same way windows-hosts.tf guards lab-topology.json.
  lifecycle {
    precondition {
      condition     = cidrhost(local.fml_cidr, local.clients.voip.cathy.ip) == local.folly_settings.data.CATHY_IP
      error_message = "clusters/folly/config/cluster-settings.yaml's CATHY_IP disagrees with the clients.yaml octet for cathy."
    }
  }
}
