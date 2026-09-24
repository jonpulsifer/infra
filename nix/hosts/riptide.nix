# riptide: folly worker node, rooted on NVMe.
{ ... }:
{
  imports = [
    ../profiles/k8s-node.nix
    ../system/sops.nix
    ../system/tailscale-disable.nix
  ];

  services.k8s.clusterCa.enable = true;

  # When i915 replaces simpledrm's card0, udev leaves a dangling by-path link to it. runc cannot recreate
  # a dangling link, so every gpu.intel.com/i915 container fails with CreateContainerError.
  systemd.services.prune-dri-by-path = {
    description = "Remove dangling /dev/dri/by-path symlinks left by the simpledrm handover";
    wantedBy = [ "multi-user.target" ];
    before = [ "kubelet.service" ];
    unitConfig.ConditionPathIsDirectory = "/dev/dri/by-path";
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };
    script = ''
      for link in /dev/dri/by-path/*; do
        [ -L "$link" ] || continue
        [ -e "$link" ] && continue
        echo "pruning dangling $link -> $(readlink "$link")"
        rm -f "$link"
      done
    '';
  };

  homelab.disko.device = "/dev/nvme0n1";

  sops.defaultSopsFile = ../secrets/riptide.sops.yaml;

  # bosun does not run here, and nothing else deletes its textfile, which would export a frozen pool.
  systemd.tmpfiles.rules = [
    "r /var/lib/prometheus-node-exporter-text-files/bosun.prom"
  ];
}
