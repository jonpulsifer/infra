{
  config,
  lib,
  modulesPath,
  ...
}:
{
  imports = [
    (modulesPath + "/virtualisation/google-compute-image.nix")
    ./server.nix
  ];

  # get the hostname from gce
  networking.hostName = lib.mkForce "";
}
