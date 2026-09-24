{
  config,
  lib,
  pkgs,
  inputs,
  ...
}:
let
  fleet = import ../lib/fleet.nix;
in
{
  imports = [
    ../../apps/ddnsd/module.nix
  ];

  nixpkgs.overlays = [
    (import ../overlays/ddnsd.nix inputs.unstable)
  ];

  services.ddnsd = {
    enable = lib.mkDefault false;
    zone = fleet.dnsZone;
    tokenFile = "/var/secrets/cloudflare-api-token";
  };
}
