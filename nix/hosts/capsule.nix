{ lib, name, ... }:
{
  imports = [
    ../hardware/pi5
    ../hardware/pi5/nvme-hat.nix
    ../services/common.nix
    ../services/coredns-sinkhole.nix
    ../services/ntp-server.nix
  ];

  networking = {
    hostName = name;
    wireless.enable = lib.mkForce false;
  };

  # Keep the labels already installed on the NVMe. The Pi 5 hardware module
  # normally derives these from `name`, but changing them during a hostname
  # migration would make the existing root and firmware filesystems disappear.
  sdImage = {
    rootVolumeLabel = lib.mkForce "NIXOS_DNS";
    firmwarePartitionName = lib.mkForce "FW_DNS";
  };
}
