{ config, lib, ... }:
{
  imports = [
    ../profiles/rpi.nix
    ../services/kiosk.nix
  ];

  networking.wireless = {
    enable = true;
    networks = {
      lab = {
        hidden = true;
      };
    };
  } 

  services.kiosk = {
    enable = true;
    container = true;
  };
}
