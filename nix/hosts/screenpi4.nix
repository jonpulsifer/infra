{ config, ... }:
{
  imports = [
    ../hardware/pi4
    ../profiles/server.nix
    ../services/kiosk.nix
  ];

  services.kiosk = {
    enable = true;
  };
}
