{
  lib,
  pkgs,
  modulesPath,
  ...
}:
{
  imports = [
    (modulesPath + "/installer/sd-card/sd-image-raspberrypi.nix")
  ];

  # save some space
  documentation.enable = false;

  # GPIO tooling for the LED HATs on this board family (pHAT BEAT on
  # radiopi0, Blinkt! on blinkypi0).
  environment.systemPackages = [ pkgs.wiringpi ];

  # Original Pi Zero W: BCM2835, single-core ARM1176JZF-S (armv6l). No
  # nixos-hardware/nixos-raspberrypi board module targets this chip (those
  # bottom out at Pi 2 / Zero 2 W), and there's no armv6l binary cache
  # anywhere -- everything in this closure compiles from source.
  # nixpkgs.buildPlatform keeps the *build* machine on its own native arch
  # (aarch64-linux on spore) while hostPlatform cross-compiles the armv6l
  # target, no QEMU emulation. Must use the modern hostPlatform/buildPlatform
  # options (matching nix/system/nixos.nix's own hostPlatform default) rather
  # than the legacy localSystem/crossSystem pair -- nixpkgs asserts against
  # mixing the two.
  nixpkgs.buildPlatform.system = "aarch64-linux";
  nixpkgs.hostPlatform = lib.systems.examples.raspberryPi;

  # efivar/efibootmgr are EFI-specific (irrelevant on this non-EFI board) --
  # systemd/dbus pull them in transitively regardless, and efivar is marked
  # broken for this cross target upstream. Stub both out entirely rather than
  # letting the real (likely genuinely broken, not just meta-flagged) cross
  # build run.
  nixpkgs.overlays = [
    (
      final: prev: {
        efivar = prev.runCommand "empty-efivar" { } "mkdir $out";
        efibootmgr = prev.runCommand "empty-efibootmgr" { } "mkdir $out";
      }
    )
  ];

  # Required for the Pi Zero W's wifi/bt firmware (bcm43438).
  hardware.enableRedistributableFirmware = true;

  boot = {
    # sd-image-raspberrypi pulls in the generic installer's filesystem set
    # (zfs, btrfs, cifs, f2fs, ntfs, xfs) via profiles/base.nix -- all
    # irrelevant here, and zfs in particular is a large, slow, from-source
    # cross build with no armv6l cache. Only ext4 (root) and vfat (firmware
    # partition) are actually used.
    supportedFilesystems = lib.mkForce [
      "ext4"
      "vfat"
    ];

    # Same installer default pulls in drivers for SATA, NVMe, RAID, virtio,
    # and USB HID devices that don't exist on this board. The Pi Zero W's SD
    # host controller is built into the kernel; only the modular MMC block
    # driver is needed to mount an ext4 root from the SD card.
    initrd = {
      availableKernelModules = lib.mkForce [ "mmc_block" ];
      kernelModules = lib.mkForce [ ];
    };
  };

  sdImage.compressImage = true;
}
