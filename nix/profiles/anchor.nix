# An anchor is one of the three Raspberry Pi 5s (capsule, spore and forge) that run the lab's
# shared network services: recursive DNS and NTP behind the ns1 and ns2 VIPs, and the Talos boot
# files, attestation and the enrollment name's HTTPS server on the bootstrap VLAN behind the boot VIP.
{ lib, ... }:
{
  options.homelab.site = lib.mkOption {
    type = lib.types.str;
    default = "folly";
    description = ''
      The site this anchor serves. The boot plane's paths, metrics labels and committed
      per-site files (terraform/pki/certs, clusters/<site>/) follow it.
    '';
  };

  imports = [
    ../services/anchor-vips.nix
    ../services/coredns-sinkhole.nix
    ../services/devid-ca-yubikey.nix
    ../services/ntp-server.nix
    ../services/talos-boot.nix
    ../services/talos-attest.nix
  ];
}
