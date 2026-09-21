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
}
