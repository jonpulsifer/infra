{ config, hostName, lib, ... }:
{
  imports = [
    ./hardware-configuration.nix
    ../nixos.nix
  ];

  networking = {
    inherit hostName;

    interfaces.eno1.useDHCP = true;
    # interfaces.wlp0s20f0u2.useDHCP = true;
    wireless = {
      enable = false;
      networks = {
        lab = { hidden = true; };
      };
    };
  };

  services.prometheus.exporters.node.enable = true;
  virtualisation.docker.enable = false;
  users.users.jawn = {
    extraGroups = lib.mkIf (config.virtualisation.docker.enable) [ "docker" ];
  };
}
