# Raspberry Pi 4 driving a full-screen dashboard on an attached display. Hosts add their
# wireless networks and, optionally, services.kiosk.public.
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
