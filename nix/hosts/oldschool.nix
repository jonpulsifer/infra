# oldschool: offsite worker node.
{ ... }:
{
  imports = [
    ../profiles/k8s-node.nix
    ../system/sops.nix
    ../system/tailscale-disable.nix
  ];

  services.k8s.clusterCa.enable = true;

  homelab.disko.device = "/dev/sda";
  # 200G, not the 100G default.
  homelab.disko.rootSize = "200G";

  sops.defaultSopsFile = ../secrets/oldschool.sops.yaml;

  # Retired jobs must not leave stale node-exporter metrics that keep alerts firing.
  systemd.tmpfiles.rules = [
    "r /var/lib/prometheus-node-exporter-text-files/bosun.prom"
    "r /var/lib/prometheus-node-exporter-text-files/lab-backup-restic-staging-prune.prom"
  ];
}
