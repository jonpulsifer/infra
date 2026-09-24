# Raspberry Pi 5 rooted on an NVMe drive behind the M.2 HAT. The sd-image is flashed onto the
# NVMe, so it relies on the per-host volume labels in nix/hardware/pi5/default.nix.
{ lib, ... }:
{
  imports = [
    ../hardware/pi5
    ../hardware/pi5/nvme-hat.nix
  ];

  # These boards are wired; the Pi 5 board module enables the radio by default.
  networking.wireless.enable = lib.mkForce false;
}
