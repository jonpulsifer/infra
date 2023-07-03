{ config, pkgs, ... }:

{
  users.users.kiosk = {
    isNormalUser = true;
    openssh.authorizedKeys.keys = config.users.users.jawn.openssh.authorizedKeys.keys;
    extraGroups = [
      "audio"
      "input"
      "networkmanager"
      "tty"
      "video"
    ];
    shell = pkgs.zsh;
  };
  services.cage = {
    enable = false;
    user = "kiosk";
    # extraArguments = [ "-d" ];
    program = "${pkgs.firefox}/bin/firefox -kiosk -private-window https://headerz.lolwtf.ca";
  };
  services.xserver.enable = true;
  services.xserver.config = ''
    Section "ServerFlags"
      Option  "DontVTSwitch"  "True"
    EndSection
  '';
  services.xserver.synaptics.enable = true;
  services.xserver.displayManager.autoLogin.enable = true;
  services.xserver.displayManager.autoLogin.user = "kiosk";
  services.xserver.desktopManager.xterm.enable = false;
  services.xserver.windowManager.default = "i3";
  services.xserver.windowManager.i3.enable = true;
  services.xserver.windowManager.i3.configFile = pkgs.writeText "config" ''
    set $mod Mod4
    new_window 1pixel
    for_window [class="Surf"] fullscreen
    exec --no-startup-id nm-applet
    exec surf -k "https://headerz.lolwtf.ca/"
  '';

  environment.systemPackages = with pkgs; [
    surf
    i3status
  ];
}
