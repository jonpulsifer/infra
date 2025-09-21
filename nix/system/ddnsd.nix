{
  config,
  lib,
  pkgs,
  inputs,
  ...
}:
{
  imports = [
    inputs.ddnsd.nixosModules.default
  ];

  nixpkgs.overlays = [
    inputs.ddnsd.overlays.pkgs
  ];

  services.ddnsd = {
    enable = lib.mkDefault true;
    zone = "lolwtf.ca";
    tokenFile = "/var/secrets/cloudflare-api-token";
  };
}
