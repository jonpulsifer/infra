{
  lib,
  modulesPath,
  ...
}:
{
  imports = [
    (modulesPath + "/installer/sd-card/sd-image-raspberrypi.nix")
  ];

  # save some space
  documentation.enable = false;

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

  boot.zfs.forceImportRoot = false;

  sdImage.compressImage = true;
}
