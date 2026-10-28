# capsule: NVMe-rooted Pi 5, one of the three anchors that run the lab's DNS and NTP, and the NetBox host.
{ lib, ... }:
{
  imports = [
    ../profiles/anchor.nix
    ../profiles/pi5-nvme.nix
    ../services/garage.nix
    ../services/netbox.nix
    ../services/netbox-drift.nix
    ../system/sops.nix
  ];

  homelab.garage = {
    enable = true;
    site = "folly";
    dataDir = "/var/lib/garage";
    clustered = true;
    bootstrap = false;
  };

  # The YubiKey 4c that holds one of the two hardware DevID CA keys.
  homelab.devidCa.yubikey.enable = true;
  homelab.devidCa.yubikey.serial = 7126381;
  # The attest service signs LDevIDs with this anchor's YubiKey CA.
  homelab.talosAttest.caKey = "pkcs11";

  sops.defaultSopsFile = ../secrets/capsule.sops.yaml;

  # The NVMe carries these labels; the per-name default (NIXOS_CAPSULE) would not find
  # the root or firmware filesystem.
  sdImage = {
    rootVolumeLabel = lib.mkForce "NIXOS_DNS";
    firmwarePartitionName = lib.mkForce "FW_DNS";
  };
}
