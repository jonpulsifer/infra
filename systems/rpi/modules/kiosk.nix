{ config, pkgs, ... }:

{
  users.users.kiosk = {
    isNormalUser = true;
    openssh.authorizedKeys.keys = config.users.users.jawn.openssh.authorizedKeys.keys;
    shell = pkgs.zsh;
  };
  services.cage = {
    enable = true;
    user = "kiosk";
    program = "DISPLAY=0:0 ${pkgs.firefox}/bin/firefox -kiosk -private-window https://headerz.lolwtf.ca";
  };
}
