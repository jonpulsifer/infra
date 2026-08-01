# capsule: NVMe-rooted Pi 5 running the other half of the lab's recursive DNS
# pair plus the lab NTP server.
{ lib, ... }:
{
  imports = [
    ../profiles/pi5-nvme.nix
    ../services/coredns-sinkhole.nix
    ../services/ntp-server.nix
  ];

  # Keep the labels already installed on the NVMe. The Pi 5 hardware module
  # normally derives these from `name`, but changing them during a hostname
  # migration would make the existing root and firmware filesystems disappear.
  sdImage = {
    rootVolumeLabel = lib.mkForce "NIXOS_DNS";
    firmwarePartitionName = lib.mkForce "FW_DNS";
  };
}
