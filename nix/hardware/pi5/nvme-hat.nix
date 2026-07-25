# 52Pi P33 M.2 NVMe M-Key & PoE+ HAT for Raspberry Pi 5
# https://wiki.52pi.com/index.php?title=EP-0241
{ pkgs, ... }:
{
  hardware.raspberry-pi.config.pi5.base-dt-params = {
    # Enables the PCIe port the HAT's M.2 slot is wired to.
    pciex1 = {
      enable = true;
    };

    # The HAT's PCIe link is certified for Gen 2.0 (5 GT/s). Gen 3.0
    # (10 GT/s) can be forced, but only once a given board+drive is tested
    # stable at that speed:
    # pciex1_gen = {
    #   enable = true;
    #   value = 3;
    # };
  };

  # rpi-eeprom-config/-update, for the bootloader step below.
  environment.systemPackages = [ pkgs.raspberrypi-eeprom ];

  # config.txt is all that's declarative here -- the bootloader config below
  # lives in the Pi's SPI EEPROM, outside the NixOS closure, so it has to be
  # applied by hand per-device with:
  #   sudo rpi-eeprom-config --edit
  # setting:
  #   PSU_MAX_CURRENT=5000   # PoE+ HAT can supply up to 5A
  #   PCIE_PROBE=1           # auto-detect the NVMe drive
  #   BOOT_ORDER=0xf461      # SD, then NVMe, then USB, then repeat. Digits
  #                          # are tried from least-significant/rightmost to
  #                          # most-significant/leftmost.
  #
  # BOOT_ORDER only matters for which device wins when more than one is
  # bootable -- it doesn't gate whether the kernel brings up the PCIe/NVMe
  # link at all (that's PCIE_PROBE plus this file's dtparam=pciex1, which
  # apply regardless of BOOT_ORDER). With no SD card installed, capsule falls
  # through to its NVMe root.
}
