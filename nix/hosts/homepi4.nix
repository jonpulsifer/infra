{ config, ... }:
{
  imports = [
    ../profiles/rpi.nix
    ../services/kiosk.nix
  ];

  services.ddnsd.enable = lib.mkForce false;

  services.kiosk = {
    enable = true;
    url = "https://hub.lolwtf.ca";
    container = true;
  };
}
