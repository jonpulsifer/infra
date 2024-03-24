{ config, pkgs, ... }:
let
  allowedIPs = [ "0.0.0.0/0" "::0/0" ];
  peers = [
    { inherit allowedIPs; endpoint = "178.249.214.2:51820"; publicKey = "L4msD0mEG2ctKDtaMJW2y3cs1fT2LBRVV7iVlWZ2nZc="; }
  ];
in
{
  # networking.wireguard.enable = true;
  # networking.firewall.allowedUDPPorts = [ 51820 ];
  services.mullvad-vpn.enable = true;
  # networking.wg-quick.interfaces = {
  #   wg-mullvad = {
  #     inherit peers;
  #     address = [ "10.68.22.178/32" "fc00:bbbb:bbbb:bb01::5:16b1/128" ];
  #     dns = [ "1.1.1.1" "1.0.0.1" "2606:4700:4700::1111" "2606:4700:4700::1001" ];
  #     privateKeyFile = "/var/secrets/wg-key";
  #     #postUp = "iptables -I OUTPUT ! -o wg-mullvad -m mark ! --mark $(wg show wg-mullvad fwmark) -m addrtype ! --dst-type LOCAL -j REJECT && ip6tables -I OUTPUT ! -o wg-mullvad -m mark ! --mark $(wg show wg-mullvad fwmark) -m addrtype ! --dst-type LOCAL -j REJECT";
  #     #preDown = "iptables -D OUTPUT ! -o wg-mullvad -m mark ! --mark $(wg show wg-mullvad fwmark) -m addrtype ! --dst-type LOCAL -j REJECT && ip6tables -D OUTPUT ! -o wg-mullvad -m mark ! --mark $(wg show wg-mullvad fwmark) -m addrtype ! --dst-type LOCAL -j REJECT";
  #   };
  # };
}
