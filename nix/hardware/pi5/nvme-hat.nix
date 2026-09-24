# 52Pi P33 M.2 NVMe M-Key & PoE+ HAT for Raspberry Pi 5
# https://wiki.52pi.com/index.php?title=EP-0241
{ pkgs, ... }:
{
  hardware.raspberry-pi.config.pi5.base-dt-params = {
    # Enables the PCIe port the HAT's M.2 slot is wired to.
    pciex1 = {
      enable = true;
    };

    # The HAT's link is certified for PCIe Gen 2 (5 GT/s). Set pciex1_gen = 3 only on a board and
    # drive tested stable at Gen 3.
  };

  # rpi-eeprom-config and rpi-eeprom-update, for the EEPROM settings below.
  environment.systemPackages = [ pkgs.raspberrypi-eeprom ];

  # Set per device with `sudo rpi-eeprom-config --edit`: PSU_MAX_CURRENT=5000 (the PoE+ HAT supplies 5 A), PCIE_PROBE=1.
  # capsule uses BOOT_ORDER=0xf461 (SD, NVMe, USB; right to left); forge's is in docs/runbooks/change-the-forge-eeprom.md.
}
