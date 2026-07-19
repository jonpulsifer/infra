{
  config,
  name,
  ...
}:
{
  imports = [
    ../hardware/pi4
    ../services/common.nix
    ../services/iperf3.nix
    ../services/kiosk.nix
  ];

  networking = {
    hostName = name;
    wireless = {
      enable = true;
      networks.Goggly = {
        priority = 100;
        pskRaw = "c1e6a7dd93cd062b1b0e1f394b54f5a80ce63de04e9d9478f87312f8099df864";
      };
      networks.Goggly2 = {
        priority = 90;
        pskRaw = "fd6e6e6bbb22865a53302494040e6e3799a2f097a8321152e264c568bc16b3d5";
      };
    };
  };

  services.kiosk = {
    enable = true;
    container = false;
    public = true;
    url = "https://hub.lolwtf.ca";
  };
}
