{
  config,
  lib,
  pkgs,
  ...
}:
{

  hardware.enableRedistributableFirmware = lib.mkDefault true;
  hardware.cpu.intel.updateMicrocode = lib.mkDefault config.hardware.enableRedistributableFirmware;
  systemd.tpm2.enable = lib.mkDefault false;
  powerManagement.cpuFreqGovernor = lib.mkDefault "ondemand";

  boot = {
    initrd = {
      availableKernelModules = [
        "xhci_pci"
        "ahci"
        "usbhid"
        "usb_storage"
      ];
      kernelModules = [ ];
      systemd.tpm2.enable = lib.mkDefault false;
    };

    kernelPackages = lib.mkDefault pkgs.linuxPackages_latest;
    kernelModules = [ ];

    consoleLogLevel = lib.mkDefault 0;
    extraModulePackages = [ ];

    loader = {
      systemd-boot.enable = lib.mkDefault true;
      efi.canTouchEfiVariables = lib.mkDefault true;
      timeout = lib.mkDefault 0;
    };
    supportedFilesystems = lib.mkForce [
      "ext4"
      "vfat"
    ];
  };

  # fileSystems come from disko on k8s nodes and from the installer modules on the ISO and netboot images.

  swapDevices = [ ];
}
