# weatherpi4: kiosk Pi 4 off-lab, joining the house SSIDs.
{ ... }:
{
  imports = [ ../profiles/pi4-kiosk.nix ];

  networking.wireless.networks = {
    Goggly = {
      priority = 100;
      pskRaw = "c1e6a7dd93cd062b1b0e1f394b54f5a80ce63de04e9d9478f87312f8099df864";
    };
    Goggly2 = {
      priority = 90;
      pskRaw = "fd6e6e6bbb22865a53302494040e6e3799a2f097a8321152e264c568bc16b3d5";
    };
  };

  services.kiosk.public = true;
}
