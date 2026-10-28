# capsule: NVMe-rooted Pi 5 and one of the three anchors that run the lab's DNS and NTP.
{ lib, ... }:
{
  imports = [
    ../profiles/anchor.nix
    ../profiles/pi5-nvme.nix
  ];

  # The NVMe carries these labels; the per-name default (NIXOS_CAPSULE) would not find
  # the root or firmware filesystem.
  sdImage = {
    rootVolumeLabel = lib.mkForce "NIXOS_DNS";
    firmwarePartitionName = lib.mkForce "FW_DNS";
  };
}
