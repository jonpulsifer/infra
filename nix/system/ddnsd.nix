{
  config,
  lib,
  pkgs,
  ...
}:
{
  # ddnsd source is vendored in-repo under apps/ddnsd; the module and package
  # build expression live alongside it rather than coming from a flake input.
  imports = [
    ../../apps/ddnsd/module.nix
  ];

  nixpkgs.overlays = [
    (import ../overlays/ddnsd.nix)
  ];

  services.ddnsd = {
    enable = lib.mkDefault false;
    zone = "lolwtf.ca";
    tokenFile = "/var/secrets/cloudflare-api-token";
  };
}
