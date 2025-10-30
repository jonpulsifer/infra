{ config, ... }:
{
  imports = [
    ../profiles/rpi.nix
    ../services/kiosk.nix
  ];

  networking.wireless = {
    enable = true;
    networks.Goggly.pskRaw = "c1e6a7dd93cd062b1b0e1f394b54f5a80ce63de04e9d9478f87312f8099df864";
  };

  services.kiosk = {
    enable = true;
    container = true;
  };
}
