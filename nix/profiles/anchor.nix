# An anchor is one of the three Raspberry Pi 5s (capsule, spore and forge) that run the lab's
# shared network services: recursive DNS and NTP behind the ns1 and ns2 VIPs, and the Talos boot
# files and enrollment server on the bootstrap VLAN behind the boot VIP.
{ ... }:
{
  imports = [
    ../services/anchor-vips.nix
    ../services/coredns-sinkhole.nix
    ../services/ntp-server.nix
    ../services/talos-boot.nix
    ../services/talos-enroll.nix
    ../services/talos-attest.nix
  ];
}
