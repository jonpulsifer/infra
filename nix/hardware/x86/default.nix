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

  # Disk layout and fileSystems are declared by disko (see ../../disko) for
  # k8s nodes. The install ISO imports this hardware module too but gets its
  # root filesystem from installation-cd-minimal.nix, so nothing is declared here.

  swapDevices = [ ];
}
