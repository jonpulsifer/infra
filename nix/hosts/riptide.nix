# riptide: folly worker node, rooted on NVMe.
{ ... }:
{
  imports = [
    ../profiles/k8s-node.nix
    ../system/sops.nix
    ../system/tailscale-disable.nix
  ];

  services.k8s.clusterCa.enable = true;

  homelab.disko.device = "/dev/nvme0n1";

  sops.defaultSopsFile = ../secrets/riptide.sops.yaml;

  # bosun does not run here, and nothing else deletes its textfile, which would export a frozen pool.
  systemd.tmpfiles.rules = [
    "r /var/lib/prometheus-node-exporter-text-files/bosun.prom"
  ];
}
