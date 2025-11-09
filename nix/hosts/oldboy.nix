{ config, modulesPath, ... }:
{
  imports = [
    (modulesPath + "/virtualisation/google-compute-image.nix")
    ../services/common.nix
  ];
}