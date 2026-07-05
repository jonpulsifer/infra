# bgp.conf is pulled in via file() below. Atlantis autoplans .conf-only edits
# via ATLANTIS_AUTOPLAN_FILE_LIST ("**/*.conf") in the atlantis HelmRelease.
resource "unifi_bgp" "offsite" {
  enabled     = true
  description = "Homelab BGP (Cilium <-> offsite ucg-max)"
  config      = file("${path.module}/bgp.conf")
}
