# Raspberry Pi 5 board support, caches and overlays, without the sd-image module.
# The RAM-booted rackpi5 imports this; disk-rooted hosts import ./default.nix.
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

  # The installer profile enables zfs, but the kernel comes from nixos-raspberrypi's nixpkgs and
  # userland zfs from ours, and the version mismatch fails an assertion.
  boot.supportedFilesystems.zfs = lib.mkForce false;
}
