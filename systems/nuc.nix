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
  ];
  services.k8s = {
    enable = true;
    network = "folly";
    role = "control-plane";
  };
  networking.hostName = name;
}
