# riptide: folly worker node, rooted on NVMe. Also the first bosun host.
{ config, inputs, ... }:
{
  imports = [
    ../profiles/k8s-node.nix
    ../system/sops.nix
    ../system/tailscale-disable.nix
    ../../apps/bosun/module.nix
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
  # bosun reads this once at startup, so a rotated token needs the unit
  # bounced -- which is what restartUnits does on the activation that
  # rewrites the secret.
  sops.secrets."bosun-github-token" = {
    owner = "bosun";
    group = "bosun";
    mode = "0400";
    restartUnits = [ "bosun.service" ];
  };

  # A skiff mounts this host's /nix/store, so the hull's closure has to be
  # here rather than merely buildable: naming the package is what puts it in
  # riptide's store.
  services.bosun = {
    enable = true;
    repo = "jonpulsifer/infra";
    tokenFile = config.sops.secrets."bosun-github-token".path;
    classes.skiff-nixos = {
      hull = "${inputs.self.packages.x86_64-linux.hull-nixos}";
      vcpus = 4;
      memory = "2048M";
      warm = 1;
    };
    # The FHS family: apt, dockerd, and the ARC image's toolchain, no Nix.
    # More memory than skiff-nixos because jobs here apt-get and docker build
    # inside the guest rather than leaning on a warm host store -- and because
    # the whole guest root is a tmpfs overlay, so this number is the class's
    # disk budget as much as its RAM. A checkout plus a docker build that
    # exceeds it is an OOM, not an ENOSPC. 8192M against riptide's ~10 GiB
    # free is the ceiling while kubelet shares the host; past that the answer
    # is a real workspace disk, not a bigger number.
    classes.skiff-ubuntu = {
      hull = "${inputs.self.packages.x86_64-linux.hull-ubuntu}";
      vcpus = 4;
      memory = "8192M";
      warm = 1;
    };
  };
}
