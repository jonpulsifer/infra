{
  config,
  lib,
  pkgs,
  name,
  inputs,
  ...
}:
{
  imports = [
    inputs.nixos-hardware.nixosModules.raspberry-pi-4
  ];

  nixpkgs.overlays = [
    # https://github.com/NixOS/nixpkgs/issues/154163
    (final: super: {
      makeModulesClosure = x: super.makeModulesClosure (x // { allowMissing = true; });
    })
  ];

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

  networking = {
    hostName = name;
    wireless.enable = lib.mkForce true;
  };

  nixpkgs = {
    # Cross compile the system from x86_64-linux to aarch64-linux if you want
    # buildPlatform.system = "x86_64-linux";
    hostPlatform.system = "aarch64-linux";
  };

  powerManagement.cpuFreqGovernor = lib.mkDefault "ondemand";
}
