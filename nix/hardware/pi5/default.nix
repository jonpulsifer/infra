{
  lib,
  name,
  nixos-raspberrypi,
  ...
}:
{
  imports = [
    ./base.nix
    nixos-raspberrypi.nixosModules.sd-image
  ];

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
