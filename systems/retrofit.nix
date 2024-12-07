{ config, ... }:
{
  imports = [
    ./modules/vpn.nix
    ./modules/yarr.nix
  ];
  services.ddnsd.enable = true;
}
