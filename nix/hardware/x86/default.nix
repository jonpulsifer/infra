{
  config,
  lib,
  pkgs,
  ...
}:
{

  hardware.cpu.intel.updateMicrocode = lib.mkDefault config.hardware.enableRedistributableFirmware;
  powerManagement.cpuFreqGovernor = lib.mkDefault "ondemand";

  boot = {
    initrd.availableKernelModules = [
      "xhci_pci"
      "ahci"
      "usbhid"
      "usb_storage"
    ];
    initrd.kernelModules = [ ];

    kernelPackages = lib.mkDefault pkgs.linuxPackages_latest;
    kernelModules = [ ];

    consoleLogLevel = lib.mkDefault 0;
    extraModulePackages = [ ];

    loader = {
      # Use the systemd-boot EFI boot loader.
      systemd-boot.enable = lib.mkDefault true;
      efi.canTouchEfiVariables = lib.mkDefault true;
      timeout = lib.mkDefault 0;
    };
    supportedFilesystems = lib.mkForce [
      "ext4"
      "vfat"
    ];
  };

  fileSystems."/boot" = {
    device = "/dev/disk/by-label/boot";
    fsType = "vfat";
  };

  fileSystems."/" = lib.mkDefault {
    device = "/dev/disk/by-label/nixos";
    fsType = "ext4";
  };

  fileSystems."/mnt/disks" = {
    device = "/dev/disk/by-label/storage";
    fsType = "ext4";
    options = [
      "nofail"
      "relatime"
    ];
  };

  swapDevices = [ ];
}
