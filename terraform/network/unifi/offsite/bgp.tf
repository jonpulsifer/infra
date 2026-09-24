# A .conf-only edit autoplans through terraform/**/*.conf in ATLANTIS_AUTOPLAN_FILE_LIST.
resource "unifi_bgp" "offsite" {
  enabled     = true
  description = "Homelab BGP (Cilium <-> offsite ucg-max)"
  config      = file("${path.module}/bgp.conf")
}
