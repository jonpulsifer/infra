# Lab network facts shared by NixOS, Flux, and OpenTofu.
#
# The source file is also the Flux ConfigMap. Keep its data flat and string-only
# so Flux post-build substitution can consume it directly.
let
  data = (builtins.fromJSON (builtins.readFile ../../clusters/folly/config/lab-topology.json)).data;
in
{
  inherit data;
  cidr = data.LAB_CIDR;
  futureCidr = data.FUTURE_CIDR;
  hosts = {
    capsule = data.CAPSULE_IP;
    spore = data.SPORE_IP;
    forge = data.FORGE_IP;
    cloudpi4 = data.CLOUDPI4_IP;
    radiopi0 = data.RADIOPI0_IP;
  };
}
