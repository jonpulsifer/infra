{ config, lib, ... }:
{
  imports = [
    ./hardware-configuration.nix
    ../nixos.nix
  ];

  networking = {
    # hostName = config.hostname;

    # networkd does not support useDHCP globally
    useNetworkd = true;
    firewall.enable = false;
    wireless.enable = true;

    useDHCP = false;
    interfaces.eno1.useDHCP = true;
    interfaces.wlp0s20f0u2.useDHCP = true;
  };

  services.prometheus.exporters.node.enable = lib.mkDefault true;
  virtualisation.docker.enable = false;
  users.users.jawn = {
    extraGroups = lib.mkIf (config.virtualisation.docker.enable) [ "docker" ];
  };
}
