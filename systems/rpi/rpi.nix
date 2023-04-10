{ config, lib, pkgs, keys, ... }:
let
  inherit (lib) mkDefault mkForce;
in
{
  imports = [
    # Include the results of the hardware scan.
    ../nixos.nix
  ];

  # Required for the Wireless firmware
  hardware.enableRedistributableFirmware = true;

  boot = {
    kernelPackages = mkForce pkgs.linuxPackages_rpi4;
    kernelParams = [
      "cma=128M"
      "cgroup_enable=cpuset"
      "cgroup_memory=1"
      "cgroup_enable=memory"
    ];
    supportedFilesystems = [ "ext4" "vfat" ];

    tmpOnTmpfs = true;

    consoleLogLevel = 7;
    loader = {
      grub.enable = false;
      #raspberryPi = {
      #  enable = mkDefault true;
      #  version = 4;
      #};
      # Use the systemd-boot EFI boot loader.
      systemd-boot.enable = false;
      efi.canTouchEfiVariables = false;
      timeout = mkForce 0;
    };
  };

  fileSystems."/" =
    {
      device = "/dev/disk/by-label/NIXOS_SD";
      fsType = "ext4";
    };
  fileSystems."/boot" =
    {
      device = "/dev/disk/by-label/FIRMWARE";
      fsType = "vfat";
    };

  networking = {
    # nameservers = mkDefault [ "1.1.1.1" "1.0.0.1" ];
    # useNetworkd = false;
    # useDHCP = true;
    interfaces.eth0.useDHCP = true;
  };

  # nixpkgs = { 
  #   buildPlatform.system = "x86_64-linux";
  #   hostPlatform.system = "aarch64-linux";
  # };
}
