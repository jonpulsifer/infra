{ lib, nixos-raspberrypi, ... }:
{
  imports = [
    nixos-raspberrypi.nixosModules.trusted-nix-caches
    nixos-raspberrypi.nixosModules.sd-image
    nixos-raspberrypi.nixosModules.raspberry-pi-5.base
    nixos-raspberrypi.lib.inject-overlays
  ];

  # save some space
  documentation.enable = false;

  nixpkgs.hostPlatform = "aarch64-linux";

  # The sd-image installer profile (nixpkgs' profiles/base.nix) defaults zfs
  # support on whenever it's available on the platform, but our kernel comes
  # from nixos-raspberrypi's own pinned nixpkgs while userland zfs comes from
  # ours -- mismatched versions trip the "kernel module and userspace tooling
  # not matching" assertion. We don't need zfs on this host anyway.
  boot.supportedFilesystems.zfs = lib.mkForce false;

  sdImage.compressImage = true;
}
