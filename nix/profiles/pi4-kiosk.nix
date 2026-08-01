# Raspberry Pi 4 driving a full-screen dashboard on an attached display.
#
# Hosts using this supply only their wireless networks and whether the kiosk's
# container port binds publicly.
{ ... }:
let
  fleet = import ../lib/fleet.nix;
in
{
  imports = [
    ../hardware/pi4
    ../services/iperf3.nix
    ../services/kiosk.nix
  ];

  networking.wireless.enable = true;

  services.kiosk = {
    enable = true;
    container = false;
    url = fleet.hubUrl;
  };
}
