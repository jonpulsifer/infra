{ lib, name, ... }:
{
  imports = [
    ../hardware/pi5
    ../hardware/pi5/nvme-hat.nix
    ../services/common.nix
    ../services/nfs-server.nix
  ];

  networking = {
    hostName = name;
    wireless.enable = lib.mkForce false;
  };
}
