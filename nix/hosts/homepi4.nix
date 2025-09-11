{ config, lib, ... }:
{
  imports = [
    ../profiles/rpi.nix
    ../services/kiosk.nix
  ];

  services.kiosk = {
    enable = true;
    container = true;
  };
}
