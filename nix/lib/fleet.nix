# Fleet-wide naming facts.
#
# Single source of truth: terraform/network/tailscale/fleet.tf.json. That file
# IS a Terraform `locals` block (the tailscale root auto-loads it as
# `local.fleet`) and doubles as the structured facts read here — no generator,
# one file, the same direct structured-facts pattern the topology ConfigMaps use.
#
# Do NOT edit names here: change fleet.tf.json and the values flow into Nix and
# Terraform alike. This module only projects the JSON onto the attribute shape
# NixOS modules consume.
let
  fleet =
    (builtins.fromJSON (builtins.readFile ../../terraform/network/tailscale/fleet.tf.json))
    .locals.fleet;
in
{
  # MagicDNS domain. Every enrolled host answers at <hostname>.<tailnet>.
  tailnet = fleet.tailnet;

  # Public DNS zone. ddnsd maintains records here and the cluster API servers
  # carry SANs under it.
  dnsZone = fleet.dns_zone;

  # Per-cluster OIDC issuer host: https://<oidcHost>/<cluster>.
  oidcHost = "oidc.${fleet.dns_zone}";

  # The dashboard the kiosk Pis display full-screen.
  hubUrl = "https://hub.${fleet.dns_zone}";
}
