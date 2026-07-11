# Raspberry Pi 5 platform without the sd-image machinery: board support,
# caches, and overlays only. Image-style configs whose root doesn't live on
# an sd-image-partitioned disk (e.g. nix/images/pi5-ram.nix's RAM-booted
# squashfs) import this; regular hosts import ./default.nix, which layers
# the sd-image module and per-host volume labels on top.
{
  lib,
  pkgs,
  nixos-raspberrypi,
  ...
}:
{
  imports = [
    nixos-raspberrypi.nixosModules.trusted-nix-caches
    nixos-raspberrypi.nixosModules.raspberry-pi-5.base
    nixos-raspberrypi.lib.inject-overlays
  ];

  # save some space
  documentation.enable = false;

  environment.systemPackages = [ pkgs.wiringpi ];

  nixpkgs.hostPlatform = "aarch64-linux";

  # The installer profiles (nixpkgs' profiles/base.nix, pulled in by both
  # sd-image and netboot) default zfs support on whenever it's available on
  # the platform, but our kernel comes from nixos-raspberrypi's own pinned
  # nixpkgs while userland zfs comes from ours -- mismatched versions trip
  # the "kernel module and userspace tooling not matching" assertion. We
  # don't need zfs on these hosts anyway.
  boot.supportedFilesystems.zfs = lib.mkForce false;
}
