{ config, ... }:
{
  imports = [
    ../hardware/pi4
    ../profiles/rpi.nix
    ../services/kiosk.nix
  ];

  services.kiosk = {
    enable = true;
  };
}
