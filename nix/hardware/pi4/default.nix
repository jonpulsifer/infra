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

  nixpkgs = {
    # Cross compile the system from x86_64-linux to aarch64-linux if you want
    # buildPlatform.system = "x86_64-linux";
    hostPlatform.system = "aarch64-linux";

    overlays = [
      # https://github.com/NixOS/nixpkgs/issues/154163
      (final: super: {
        makeModulesClosure = x: super.makeModulesClosure (x // { allowMissing = true; });
      })
    ];
  };

  boot = {
    zfs.forceImportRoot = false;

    # The generic aarch64 installer image pulls in all-hardware.nix, which
    # otherwise adds drivers for SATA, NVMe, RAID, virtio, displays, and other
    # boards to the initrd.  The Pi 4 kernel has its SD host controller and
    # ext4 support built in; only the modular MMC block driver is needed to
    # mount an ext4 root from the SD card.
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
    # sd-image-aarch64 enables the installer filesystem set by default.  These
    # hosts only need ext4 for root and vfat for the firmware partition.
    supportedFilesystems = lib.mkForce [
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

  # Required for the Wireless firmware
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
