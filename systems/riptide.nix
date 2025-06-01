{
  config,
  lib,
  pkgs,
  name,
  ...
}:
{
  imports = [
    ../nix/modules/k8s
  ];
  services.k8s = {
    enable = true;
    network = "folly";
  };
  networking.hostName = name;
}
