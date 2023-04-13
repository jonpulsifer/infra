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
    supportedFilesystems = [ "ext4" "vfat" "zfs" ];

    # this runs out of space sometimes
    tmpOnTmpfs = false;
    consoleLogLevel = 7;
    loader = {
      # we legacy boot
      systemd-boot.enable = false;
      efi.canTouchEfiVariables = false;
      timeout = mkForce 1;
    };
  };

  fileSystems."/" =
    {
      device = "/dev/disk/by-label/NIXOS_SD";
      fsType = "ext4";
      options = [ "noatime" ];
    };

  networking = {
    inherit hostName;
    wireless.enable = mkForce true;
    wireless.networks.lab = { hidden = true; };
  };
  systemd.network =
    let
      routes = [
        { Gateway = "10.2.0.5"; Destination = "10.3.0.0/24"; GatewayOnLink = true; }
        { Gateway = "10.2.0.5"; Destination = "10.100.0.0/16"; GatewayOnLink = true; }
      ];
    in
    {
      networks."10-wired" = { inherit routes; };
      networks."11-wlan" = { inherit routes; };
    };


  nixpkgs = {
    # buildPlatform.system = "x86_64-linux";
    hostPlatform.system = "aarch64-linux";
  };

  powerManagement.cpuFreqGovernor = mkDefault "ondemand";
}
