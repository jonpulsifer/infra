{
  config,
  lib,
  pkgs,
  keys,
  name,
  inputs,
  ...
}:
{
  imports = [
    ./nixos.nix
    inputs.nixos-hardware.nixosModules.raspberry-pi-4
    "${inputs.nixos}/nixos/modules/installer/sd-card/sd-image-aarch64.nix"
  ];

  nixpkgs.overlays = [
    # https://github.com/NixOS/nixpkgs/issues/154163
    (final: super: {
      makeModulesClosure = x: super.makeModulesClosure (x // { allowMissing = true; });
    })
  ];

  sdImage.compressImage = true;
  sdImage.firmwareSize = 512;

  # Required for the Wireless firmware
  hardware.enableRedistributableFirmware = true;
  hardware.cpu.intel.updateMicrocode = lib.mkForce false;

  boot = {
    kernelPackages = lib.mkForce pkgs.linuxPackages_rpi4;
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
      timeout = lib.mkForce 1;
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
    wireless.enable = lib.mkForce true;
    wireless.networks.lab = {
      hidden = true;
    };
  };

  nixpkgs = {
    # Cross compile the system from x86_64-linux to aarch64-linux if you want
    # buildPlatform.system = "x86_64-linux";
    hostPlatform.system = "aarch64-linux";
  };

  powerManagement.cpuFreqGovernor = lib.mkDefault "ondemand";
}
