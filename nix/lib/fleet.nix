# Fleet naming facts from terraform/network/tailscale/fleet.tf.json, which is also a Terraform
# locals block. Edit names there, not here.
let
  fleet =
    (builtins.fromJSON (builtins.readFile ../../terraform/network/tailscale/fleet.tf.json))
    .locals.fleet;
in
{
  # MagicDNS domain: every enrolled host answers at <hostname>.<tailnet>.
  tailnet = fleet.tailnet;

  # Public DNS zone for ddnsd records and the cluster API server SANs.
  dnsZone = fleet.dns_zone;

  # Per-cluster OIDC issuer host: https://<oidcHost>/<cluster>.
  oidcHost = "oidc.${fleet.dns_zone}";

  # The dashboard the kiosk Pis display full-screen.
  hubUrl = "https://hub.${fleet.dns_zone}";
}
