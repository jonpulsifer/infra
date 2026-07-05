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
  #   BOOT_ORDER=0xf416      # try NVMe, then USB, then SD, repeat
  #
  # BOOT_ORDER is what actually enables booting from NVMe -- only set it on
  # hosts that should boot from the M.2 drive. dns has this HAT
  # installed but should keep booting from its SD card for now.
}
