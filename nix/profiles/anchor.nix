# An anchor is one of the three Raspberry Pi 5s (capsule, spore and forge) that run the lab's
# shared network services: recursive DNS and NTP.
{ ... }:
{
  imports = [
    ../services/coredns-sinkhole.nix
    ../services/ntp-server.nix
  ];
}
