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

    # Per-host labels: two sd-image devices on one kernel, such as a recovery SD card next to
    # an sd-image NVMe, otherwise race for /dev/disk/by-label/NIXOS_SD.
    rootVolumeLabel = "NIXOS_${lib.toUpper name}";
    firmwarePartitionName = "FW_${lib.toUpper name}";
  };
}
