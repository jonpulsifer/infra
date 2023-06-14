{ config, lib, pkgs, modulesPath, ... }:

{
  imports = [
    (modulesPath + "/installer/scan/not-detected.nix")
    ./modules/samba.nix
  ];
  nixpkgs.hostPlatform = lib.mkDefault "x86_64-linux";
  boot.initrd.availableKernelModules = [
    "ata_piix"
    "ehci_pci"
    "usbhid"
    "usb_storage"
    "sr_mod"
    "sd_mod"
  ];
  boot.initrd.kernelModules = [ ];
  boot.kernelModules = [ "kvm-intel" ];
  boot.extraModulePackages = [ ];

  # zfs
  boot.supportedFilesystems = [ "zfs" ];
  boot.kernelPackages = config.boot.zfs.package.latestCompatibleLinuxPackages;
  # boot.kernelParams = [ "zfs.zfs_arc_max=17179860388" ];
  boot.zfs.extraPools = [ "pool" ];
  services.zfs.autoScrub.enable = true;
  networking.hostid = "0xdeadbeef";
  fileSystems."/pool" = {
    device = "/dev/disk/by-id/ata-WDC_WD10EALX-009BA0_WD-WCATR8566053-part3";
    fsType = "zfs";
  };

  fileSystems."/" = {
    device = "/dev/disk/by-label/nixos";
    fsType = "ext4";
  };

  fileSystems."/boot" = {
    device = "/dev/disk/by-label/boot";
    fsType = "vfat";
  };

  swapDevices = [ ];

  networking.hostName = "htpc";

  powerManagement.cpuFreqGovernor = lib.mkDefault "performance";
  hardware.cpu.intel.updateMicrocode = lib.mkDefault config.hardware.enableRedistributableFirmware;
  console.font =
    lib.mkDefault "${pkgs.terminus_font}/share/consolefonts/ter-u28n.psf.gz";
}
