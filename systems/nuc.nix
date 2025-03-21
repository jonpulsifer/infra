{ config, name, ... }:
{
  imports = [
    ../nix/modules/k8s/control-plane.nix
  ];
  networking.hostName = name;
}
