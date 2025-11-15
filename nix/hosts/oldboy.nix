{
  config,
  lib,
  modulesPath,
  name,
  ...
}:
{
  imports = [
    (modulesPath + "/virtualisation/google-compute-image.nix")
    ../services/common.nix
  ];

  networking.hostName = name;
}
