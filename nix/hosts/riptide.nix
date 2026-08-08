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
