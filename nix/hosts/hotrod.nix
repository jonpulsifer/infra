# hotrod: offsite worker node.
{ ... }:
{
  imports = [
    ../profiles/k8s-node.nix
    ../system/tailscale-disable.nix
  ];

  services.k8s.clusterCa.enable = true;

  homelab.disko.device = "/dev/nvme0n1";
}
