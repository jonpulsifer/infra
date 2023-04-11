{ config, lib, pkgs, keys, hostName, ... }:
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
    kernelPackages = pkgs.linuxPackages_rpi4;
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
      # we legacy boot
      systemd-boot.enable = false;
      efi.canTouchEfiVariables = false;
      timeout = mkForce 10;
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
    inherit hostName;
    interfaces.end0.useDHCP = true;
    interfaces.wlan0.useDHCP = true;
    wireless.enable = true;
    wireless.networks.lab = { hidden = true; };
  };

  nixpkgs = {
    # buildPlatform.system = "x86_64-linux";
    hostPlatform.system = "aarch64-linux";
  };

  powerManagement.cpuFreqGovernor = mkDefault "ondemand";
}
