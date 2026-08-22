# riptide: folly worker node, rooted on NVMe.
{ ... }:
{
  imports = [
    ../profiles/k8s-node.nix
    ../system/sops.nix
    ../system/tailscale-disable.nix
  ];

  services.k8s.clusterCa.enable = true;

  # simpledrm claims card0 early in boot and i915 replaces it with card1 a
  # second later, but udev leaves
  # /dev/dri/by-path/pci-...-platform-simple-framebuffer.0-card pointing at the
  # card0 that no longer exists. runc cannot recreate a symlink whose target is
  # missing, so every container handed the DRI directory — which is what the
  # Intel device plugin does for a gpu.intel.com/i915 claim — dies in
  # CreateContainerError. Prune the danglers before kubelet can start a pod.
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

  # bosun no longer runs here, and nothing prunes the drop box: a leftover
  # bosun.prom keeps exporting the pool it last saw, frozen, forever.
  systemd.tmpfiles.rules = [
    "r /var/lib/prometheus-node-exporter-text-files/bosun.prom"
  ];
}
