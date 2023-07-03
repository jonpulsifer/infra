{ config, pkgs, ... }:

{
  users.users.kiosk = {
    isNormalUser = true;
    openssh.authorizedKeys.keys = config.users.users.jawn.openssh.authorizedKeys.keys;
    extraGroups = [ "tty" ];
    shell = pkgs.zsh;
  };
  services.cage = {
    enable = true;
    user = "kiosk";
    program = "${pkgs.firefox}/bin/firefox -kiosk -private-window https://headerz.lolwtf.ca";
  };
  systemd.services."getty@tty1".enable = false;
  systemd.services."autovt@".enable = false;
}
