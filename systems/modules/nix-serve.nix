{ config, lib, ... }:

{
  services.nix-serve = {
    enable = true;
    secretKeyFile = "/var/secrets/nix-serve/cache.key";
  };
  nix.gc.options = lib.mkForce "--delete-older-than 180d";
}
