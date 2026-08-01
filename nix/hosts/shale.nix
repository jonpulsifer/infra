# shale: folly worker node, rooted on a SATA disk.
{ ... }:
{
  imports = [
    ../profiles/k8s-node.nix
    ../system/tailscale-disable.nix
  ];

  services.k8s.clusterCa.enable = true;

  homelab.disko.device = "/dev/sda";
}
