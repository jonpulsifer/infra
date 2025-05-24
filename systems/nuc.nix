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
    role = "control-plane";
  };
  networking.hostName = name;
}
