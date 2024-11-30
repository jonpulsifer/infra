{ config, lib, pkgs, ... }:

{
  services.nix-serve = {
    enable = true;
    package = pkgs.nix-serve-ng;
    secretKeyFile = "/var/secrets/nix-serve/cache.key";
  };
  nix.gc.options = lib.mkForce "--delete-older-than 180d";
}
