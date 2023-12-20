{ config, lib, pkgs, keys, ... }:
let
  inherit (lib) mkDefault mkForce;
in
{
  imports = [
    # Include the results of the hardware scan.
  ];

  # Required for the Wireless firmware
  hardware.enableRedistributableFirmware = true;

  boot = {
    kernelPackages = pkgs.linuxPackages_rpi4;
    kernelParams = [
      "console=tty0"
      "cma=256M"
      "cgroup_enable=cpuset"
      "cgroup_enable=memory"
    ];
    supportedFilesystems = [ "ext4" "vfat" ];

    # this runs out of space sometimes
    tmp = { useTmpfs = false; };
    consoleLogLevel = 7;
    loader = {
      # we legacy boot
      systemd-boot.enable = false;
      efi.canTouchEfiVariables = false;
      timeout = mkForce 1;
    };
  };

  documentation.enable = false;

  fileSystems."/" = {
    device = "/dev/disk/by-label/NIXOS_SD";
    fsType = "ext4";
    options = [ "noatime" ];
  };

  networking = {
    wireless.enable = mkForce true;
    wireless.networks.lab = { hidden = true; };
  };

  nixpkgs = {
    # buildPlatform.system = "x86_64-linux";
    hostPlatform.system = "aarch64-linux";
  };

  powerManagement.cpuFreqGovernor = mkDefault "ondemand";
}
