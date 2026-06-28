resource "unifi_bgp" "offsite" {
  enabled     = true
  description = "Homelab BGP (Cilium <-> offsite ucg-max)"
  config      = file("${path.module}/bgp.conf")
}
