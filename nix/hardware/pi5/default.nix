{
  lib,
  name,
  nixos-raspberrypi,
  ...
}:
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

  sdImage = {
    compressImage = true;

    # Every sd-image build defaults to the exact same "NIXOS_SD"/"FIRMWARE"
    # labels, so any two sd-image-flashed devices attached to the same
    # running kernel at once (e.g. a recovery SD card next to a
    # sd-image-flashed NVMe drive) race for /dev/disk/by-label/NIXOS_SD --
    # this is exactly what hung spore's boot with its NVMe attached.
    # Per-host labels make that impossible.
    rootVolumeLabel = "NIXOS_${lib.toUpper name}";
    firmwarePartitionName = "FW_${lib.toUpper name}";
  };
}
