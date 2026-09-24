{
  config,
  lib,
  inputs,
  modulesPath,
  ...
}:
{
  imports = [
    inputs.nixos-hardware.nixosModules.raspberry-pi-4
    (modulesPath + "/installer/sd-card/sd-image-aarch64.nix")
  ];

  # save some space
  documentation.enable = false;

  # These Pi 4 hosts root on microSD. Build their generations elsewhere and
  # push them explicitly instead of writing a new closure to flash every day.
  system.autoUpgrade.enable = false;

  nixpkgs = {
    hostPlatform.system = "aarch64-linux";

    overlays = [
      # Tolerate initrd modules the Pi kernel does not build ("modprobe: FATAL: Module ... not found").
      (final: super: {
        makeModulesClosure = x: super.makeModulesClosure (x // { allowMissing = true; });
      })
    ];
  };

  boot = {
    zfs.forceImportRoot = false;

    # The aarch64 installer adds all-hardware.nix's initrd drivers. The Pi 4 kernel builds in SD and
    # ext4 support, so an SD root needs only mmc_block.
    initrd = {
      availableKernelModules = lib.mkForce [ "mmc_block" ];
      kernelModules = lib.mkForce [ ];
    };

    kernelParams = [
      "console=tty0"
      "cma=256M"
      "cgroup_enable=cpuset"
      "cgroup_enable=memory"
    ];
    # sd-image-aarch64 enables the installer filesystem set; these hosts use only ext4 and vfat.
    supportedFilesystems = lib.mkForce [
      "ext4"
      "vfat"
    ];

    # A tmpfs /tmp runs out of space.
    tmp = {
      useTmpfs = false;
    };
    consoleLogLevel = 7;
    loader = {
      systemd-boot.enable = false;
      efi.canTouchEfiVariables = false;
      timeout = lib.mkForce 1;
    };
  };

  # Required for the wireless firmware.
  hardware.enableRedistributableFirmware = true;
  hardware.cpu.intel.updateMicrocode = lib.mkForce false;

  powerManagement.cpuFreqGovernor = lib.mkDefault "ondemand";

  sdImage.compressImage = true;
  sdImage.firmwareSize = 512;

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
}
