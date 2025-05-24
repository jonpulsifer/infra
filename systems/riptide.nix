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
  ];
  services.k8s = {
    enable = true;
    network = "folly";
    role = "worker";
  };
  networking.hostName = name;
}
