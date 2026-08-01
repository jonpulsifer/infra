# homepi4: kiosk Pi 4 on the hidden lab SSID.
{ ... }:
{
  imports = [ ../profiles/pi4-kiosk.nix ];

  networking.wireless.networks.lab.hidden = true;
}
