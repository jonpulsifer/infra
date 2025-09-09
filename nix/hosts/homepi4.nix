{ config, lib, ... }:
{
  imports = [
    ../profiles/rpi.nix
    ../services/kiosk.nix
  ];

  services.ddnsd.enable = lib.mkForce false;

  services.kiosk = {
    enable = true;
    container = true;
  };
}
