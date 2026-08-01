# cloudpi4: wired Pi 4 running one half of the lab's recursive DNS pair.
{ ... }:
{
  imports = [
    ../hardware/pi4
    ../services/coredns-sinkhole.nix
    ../services/iperf3.nix
  ];

  networking.wireless.enable = false;
}
