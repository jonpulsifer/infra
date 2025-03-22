{
  config,
  lib,
  pkgs,
  keys,
  name,
  ...
}:
let
  inherit (lib) mkDefault mkForce;
in
{
  imports = [
    ../nix/modules/kiosk.nix
  ];

  # Required for the Wireless firmware
  hardware.enableRedistributableFirmware = true;
  hardware.cpu.intel.updateMicrocode = lib.mkForce false;

  boot = {
    kernelPackages = pkgs.linuxPackages_rpi4;
    kernelParams = [
      "console=tty0"
      "cma=256M"
      "cgroup_enable=cpuset"
      "cgroup_enable=memory"
    ];
    supportedFilesystems = [
      "ext4"
      "vfat"
    ];

    # this runs out of space sometimes
    tmp = {
      useTmpfs = false;
    };
    consoleLogLevel = 7;
    loader = {
      # we legacy boot
      systemd-boot.enable = false;
      efi.canTouchEfiVariables = false;
      timeout = mkForce 1;
    };
  };

  documentation.enable = false;

  fileSystems = lib.mkForce {
    "/" = {
      device = "/dev/disk/by-label/NIXOS_SD";
      fsType = "ext4";
      options = [ "noatime" ];
    };
    "/boot/firmware" = {
      device = "/dev/disk/by-label/FIRMWARE";
      fsType = "vfat";
      options = [
        "noauto"
        "nofail"
      ];
    };
  };

  networking = {
    hostName = name;
    wireless.enable = mkForce true;
    wireless.networks.lab = {
      hidden = true;
    };
  };

  nixpkgs = {
    # buildPlatform.system = "x86_64-linux";
    hostPlatform.system = "aarch64-linux";
  };

  powerManagement.cpuFreqGovernor = mkDefault "ondemand";
}
