{ config, name, ... }:
{
  imports = [
    ../hardware/pi4
    ../services/common.nix
    ../services/iperf3.nix
    ../services/kiosk.nix
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

  services.kiosk = {
    enable = true;
    container = true;
    url = "https://tronbyt.lolwtf.ca/tv/next";
  };
}
