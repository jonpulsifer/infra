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
  boot.initrd.availableKernelModules = [ "nvme" ];
  boot.kernelModules = [ "kvm-intel" ];
  services.k8s = {
    enable = false;
    network = "folly";
  };
  networking.hostName = name;
}
