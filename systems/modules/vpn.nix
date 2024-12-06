{ config, pkgs, ... }:
let
  allowedIPs = [ "0.0.0.0/0" "::0/0" ];
  peers = [
    { inherit allowedIPs; endpoint = "178.249.214.2:51820"; publicKey = "L4msD0mEG2ctKDtaMJW2y3cs1fT2LBRVV7iVlWZ2nZc="; }
  ];
in
{
  services.prometheus.exporters.node.enable = false;
  networking.nftables.enable = true;
  services.mullvad-vpn.enable = true;
}
