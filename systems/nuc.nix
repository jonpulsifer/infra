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
    enable = false;
    network = "folly";
    role = "control-plane";
  };
  networking.hostName = name;
}
