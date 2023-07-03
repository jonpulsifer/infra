{ config, pkgs, ... }:

{
  boot.plymouth.enable = true;

  services.dbus.enable = true;

  environment.systemPackages = [ pkgs.hicolor-icon-theme ];

  fonts.enableDefaultFonts = true;
  xdg.icons.enable = true;
  gtk.iconCache.enable = true;

  users.users.kiosk = {
    isNormalUser = true;
    openssh.authorizedKeys.keys = config.users.users.jawn.openssh.authorizedKeys.keys;
    extraGroups = [ "tty" ];
    shell = pkgs.zsh;
  };
  services.cage = {
    enable = true;
    user = "kiosk";
    extraArguments = [ "-d" ];
    program = "${pkgs.firefox}/bin/firefox -kiosk -private-window https://headerz.lolwtf.ca";
  };
  systemd.services."getty@tty1".enable = false;
  systemd.services."autovt@".enable = false;
}
