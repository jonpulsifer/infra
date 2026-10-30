# capsule: NVMe-rooted Pi 5, one of the three anchors that run the lab's DNS and NTP, and the NetBox host.
{ lib, ... }:
{
  imports = [
    ../profiles/anchor.nix
    ../profiles/pi5-nvme.nix
    ../services/garage.nix
    ../services/netbox.nix
    ../system/sops.nix
  ];

  homelab.garage = {
    enable = true;
    site = "folly";
    dataDir = "/var/lib/garage";
    clustered = true;
    bootstrap = false;
  };

  # The YubiKey 4c that holds capsule's DevID CA key. fleetd on spore issues every LDevID now;
  # the ones this CA issued stay trusted through the site's bundle until their nodes renew.
  homelab.devidCa.yubikey.enable = true;
  homelab.devidCa.yubikey.serial = 7126381;

  sops.defaultSopsFile = ../secrets/capsule.sops.yaml;

  # The NVMe carries these labels; the per-name default (NIXOS_CAPSULE) would not find
  # the root or firmware filesystem.
  sdImage = {
    rootVolumeLabel = lib.mkForce "NIXOS_DNS";
    firmwarePartitionName = lib.mkForce "FW_DNS";
  };
}
