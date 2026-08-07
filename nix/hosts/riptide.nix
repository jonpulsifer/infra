# riptide: folly worker node, rooted on NVMe. Also the first bosun host.
{ inputs, ... }:
{
  imports = [
    ../profiles/k8s-node.nix
    ../system/tailscale-disable.nix
    ../../apps/bosun/module.nix
  ];

  services.k8s.clusterCa.enable = true;

  homelab.disko.device = "/dev/nvme0n1";

  # A skiff mounts this host's /nix/store, so the hull's closure has to be
  # here rather than merely buildable: naming the package is what puts it in
  # riptide's store.
  services.bosun = {
    enable = true;
    repo = "jonpulsifer/infra";
    tokenFile = "/var/secrets/bosun-github-token";
    classes.skiff-nixos = {
      hull = "${inputs.self.packages.x86_64-linux.hull-nixos}";
      vcpus = 4;
      memory = "2048M";
      warm = 1;
    };
  };
}
