# oldschool: offsite worker node that also runs yarr.
{ ... }:
{
  imports = [
    ../profiles/k8s-node.nix
    ../services/restic-server.nix
    ../services/yarr.nix
    ../system/quiker.nix
    ../system/sops.nix
    ../system/tailscale-disable.nix
  ];

  services.k8s.clusterCa.enable = true;

  homelab.disko.device = "/dev/sda";
  # 200G, not the 100G default, leaves room for builds and a harmonia cache.
  homelab.disko.rootSize = "200G";

  # offsite pushes staging to GCS nightly at 05:00; prune after it.
  homelab.resticServer = {
    enable = true;
    site = "offsite";
    dataDir = "/mnt/disks/restic";
    pruneOnCalendar = "*-*-* 07:00:00 America/Halifax";
  };

  sops.defaultSopsFile = ../secrets/oldschool.sops.yaml;
  # harmonia's signing key (public half: nix/secrets/oldschool-harmonia-cache.pub). No service reads it yet.
  sops.secrets."harmonia-cache-key" = { };

  # bosun does not run here, and nothing else deletes its textfile, which would export a frozen pool.
  systemd.tmpfiles.rules = [
    "r /var/lib/prometheus-node-exporter-text-files/bosun.prom"
  ];
}
