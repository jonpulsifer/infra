# BGP / FRR config for the folly UDM Pro (provider site = "default").
#
# The folly k8s nodes run Cilium with a BGP control plane (ASN 64513) and peer
# with the UDM Pro (ASN 64512, router-id 10.3.0.1) — see
# clusters/folly/networking/cilium/bgp.yaml. Previously the FRR config was
# uploaded to the UDM by hand (Network > Routing > BGP); this resource brings
# that config under Terraform so it ships through Atlantis like everything else.
#
# We use the raw `config` mode rather than the structured asn/router_id/peers
# attributes: the config relies on custom prefix-lists and route-maps
# (HOMELAB-IN / HOMELAB-OUT) that the provider's structured FRR template cannot
# express. bgp-folly.conf is the source of truth for what runs on the gateway.
#
# unifi_bgp is a per-site singleton (v2/api/site/<site>/bgp/config) where the
# provider's Create and Update are the same POST upsert, so the first apply
# adopts the already-running config in place — it does not destroy/recreate.
#
# NOTE: the bgp-*.conf files are pulled in via file() below. Atlantis only
# autoplans on its autoplan-file-list (ATLANTIS_AUTOPLAN_FILE_LIST in the
# atlantis HelmRelease), which includes "**/*.conf" so .conf-only edits in this
# root and network/unifi/offsite plan too. (The earlier anchored
# "network/unifi/**/*.conf" glob failed to match and never autoplanned.)
resource "unifi_bgp" "folly" {
  enabled     = true
  description = "Homelab BGP (Cilium <-> folly udm-pro)"
  config      = file("${path.module}/bgp-folly.conf")
  # site is omitted, so it defaults to the provider's site ("default")
}

removed {
  from = unifi_bgp.offsite

  lifecycle {
    destroy = false
  }
}
