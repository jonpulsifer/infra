{ lib, name, ... }:
{
  imports = [
    ../hardware/pi5
    ../services/common.nix
  ];

  networking = {
    hostName = name;
    wireless.enable = lib.mkForce false;
  };
}
