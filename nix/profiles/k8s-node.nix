{
  lib,
  name,
  pkgs,
  ...
}:
{
  imports = [
    ../hardware/x86
    ../disko
    ../services/common.nix
    ../services/k8s
  ];

  boot.initrd.availableKernelModules = [ "nvme" ];
  boot.initrd.kernelModules = [ "nfs" ];
  boot.initrd.supportedFilesystems = [ "nfs" ];
  boot.supportedFilesystems = lib.mkOverride 40 [
    "ext4"
    "vfat"
    "nfs"
  ];
  boot.kernelModules = [ "kvm-intel" ];

  environment.systemPackages = with pkgs; [
    nfs-utils
  ];

  services.k8s.enable = true;
  networking.hostName = name;

}
