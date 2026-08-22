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
  # ddnsd source is vendored in-repo under apps/ddnsd; the module and package
  # build expression live alongside it rather than coming from a flake input.
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
