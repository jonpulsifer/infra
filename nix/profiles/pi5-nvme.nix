# Raspberry Pi 5 rooted on an NVMe drive behind the M.2 HAT.
#
# The sd-image is flashed straight onto the NVMe, so per-host volume labels
# (nix/hardware/pi5/default.nix) matter here: two sd-image-flashed devices
# attached to one running kernel would otherwise race for the same label.
{ lib, ... }:
{
  imports = [
    ../hardware/pi5
    ../hardware/pi5/nvme-hat.nix
  ];

  # These boards are wired; the Pi 5 board module enables the radio by default.
  networking.wireless.enable = lib.mkForce false;
}
