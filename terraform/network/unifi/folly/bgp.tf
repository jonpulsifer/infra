# Raw FRR config: its prefix-lists and route-maps are beyond the structured attributes.
# Create is an upsert on this per-site singleton, so an apply adopts the running config.
# A .conf-only edit autoplans through terraform/**/*.conf in ATLANTIS_AUTOPLAN_FILE_LIST.
resource "unifi_bgp" "folly" {
  enabled     = true
  description = "Homelab BGP (Cilium <-> folly udm-pro)"
  config      = file("${path.module}/bgp-folly.conf")
}
