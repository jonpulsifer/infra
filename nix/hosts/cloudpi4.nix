{
  name,
  ...
}:
{
  imports = [
    ../hardware/pi4
    ../services/common.nix
    ../services/coredns-sinkhole.nix
    ../services/iperf3.nix
  ];

  networking = {
    hostName = name;
    wireless.enable = false;
  };
}
