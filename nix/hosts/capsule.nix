# capsule: NVMe-rooted Pi 5 running the other half of the lab's recursive DNS
# pair plus the lab NTP server.
{ lib, ... }:
{
  imports = [
    ../profiles/pi5-nvme.nix
    ../services/coredns-sinkhole.nix
    ../services/ntp-server.nix
  ];

  # The NVMe carries these labels; the per-name default (NIXOS_CAPSULE) would not find
  # the root or firmware filesystem.
  sdImage = {
    rootVolumeLabel = lib.mkForce "NIXOS_DNS";
    firmwarePartitionName = lib.mkForce "FW_DNS";
  };
}
