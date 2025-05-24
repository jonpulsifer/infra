{
  config,
  lib,
  pkgs,
  name,
  ...
}:
{
  imports = [
    ../nix/modules/k8s/default.nix
    ../nix/modules/k8s/common.nix
    ../nix/modules/k8s/worker.nix
  ];
  services.k8s = {
    enable = true;
    network = "folly";
    role = "worker";
  };
  networking.hostName = name;
}
