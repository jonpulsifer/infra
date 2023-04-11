{ config, pkgs, ... }:
let hostName = "nuc"; in
{
  imports = [
    # Include the results of the hardware scan.
    ./hardware-configuration.nix
    ../nixos.nix
  ];

  networking = {
    inherit hostName;
    interfaces.eno1.useDHCP = true;
    # wireless
    interfaces.wlp0s20f3.useDHCP = true;
    wireless = {
      enable = true;
      networks = {
        lab = { hidden = true; };
      };
    };
  };

  virtualisation.docker.enable = false;
  users.users.jawn = {
    extraGroups = pkgs.lib.mkIf (config.virtualisation.docker.enable) [ "docker" ];
  };
}
