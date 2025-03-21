{ config, name, ... }:
{
  imports = [
    ../nix/modules/k8s/worker.nix
  ];
  networking.hostName = name;
}
