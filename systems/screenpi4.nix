{ config, pkgs, ... }:
{
  imports = [
    ../nix/modules/kiosk.nix
  ];

  services.kiosk = {
    enable = true;
  };
}
