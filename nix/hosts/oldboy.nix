{ config, lib, modulesPath, ... }:
{
  imports = [
    (modulesPath + "/virtualisation/google-compute-image.nix")
    ../services/common.nix
  ];

  networking.hostName = lib.mkForce null;
}