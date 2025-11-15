{
  config,
  lib,
  name,
  ...
}:
{
  imports = [
    ../images/gce.nix
    ../services/common.nix
  ];

  networking.hostName = name;
}
