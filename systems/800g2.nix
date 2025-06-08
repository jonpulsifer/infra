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
  boot.kernelModules = [ "kvm-intel" ];
  services.k8s = {
    enable = false;
    network = "folly";
  };
  networking.hostName = name;
}
