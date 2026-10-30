# Anchor network facts shared by NixOS, Flux and OpenTofu. The source file is also the Flux
# ConfigMap: keep its data flat and string-only for post-build substitution.
let
  data =
    (builtins.fromJSON (builtins.readFile ../../clusters/folly/config/anchor-topology.json)).data;
in
{
  inherit data;
  cidr = data.ANCHOR_CIDR;
  futureCidr = data.FUTURE_CIDR;
  bootstrap = {
    cidr = data.BOOTSTRAP_CIDR;
    vlan = builtins.fromJSON data.BOOTSTRAP_VLAN;
    # spore alone serves the boot plane (../services/talos-boot.nix, ../services/fleetd.nix).
    hosts.spore = data.SPORE_BOOTSTRAP_IP;
  };
  # The anchors' shared VIPs for DNS and NTP (../services/anchor-vips.nix).
  ns = {
    ns1 = data.NS1_IP;
    ns2 = data.NS2_IP;
  };
  # The anchors' shared VIP for the Garage S3 API (../services/anchor-vips.nix).
  s3Vip = data.S3_VIP;
  hosts = {
    capsule = data.CAPSULE_IP;
    spore = data.SPORE_IP;
    forge = data.FORGE_IP;
    cloudpi4 = data.CLOUDPI4_IP;
    radiopi0 = data.RADIOPI0_IP;
  };
}
