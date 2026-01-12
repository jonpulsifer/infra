{ config, name, ... }:
{
  imports = [
    ../hardware/pi5
    ../services/common.nix
  ];

  networking = {
    hostName = name;
    wireless = {
      enable = true;
      networks = {
        lab = {
          hidden = true;
        };
      };
    };
  };
}
