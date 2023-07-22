{ config, lib, pkgs, ... }:
let
  kioskUser = "kiosk";
  kioskUrl = "https://headerz.lolwtf.ca";
in
{
  # boot.kernelParams = [ "nomodeset" ];
  hardware.raspberry-pi."4".touch-ft5406.enable = true;

  users.users.${kioskUser} = {
    isNormalUser = true;
    openssh.authorizedKeys.keys = config.users.users.jawn.openssh.authorizedKeys.keys;
    extraGroups = [
      "audio"
      "input"
      "tty"
      "video"
    ];
    shell = pkgs.zsh;
  };

  environment.systemPackages = with pkgs; [
    i3status
  ];

  services.xserver = {
    enable = true;
    # config = ''
    #   Section "ServerFlags"
    #     Option  "DontVTSwitch"  "True"
    #   EndSection
    # '';
    desktopManager = {
      xterm.enable = false;
    };
    displayManager = {
      autoLogin = {
        enable = true;
        user = kioskUser;
      };
      defaultSession = "none+i3";
      lightdm = {
        enable = true;
        greeter.enable = false;
      };
    };
    windowManager = {
      i3.enable = true;
      i3.configFile = pkgs.writeText "config" ''
        set $mod Mod4
        new_window 1pixel
        for_window [class="Surf"] fullscreen
        exec ${pkgs.firefox}/bin/firefox -kiosk "https://hajimari.lolwtf.ca"
      '';
    };
  };

  hardware.opengl.enable = true;
  hardware.bluetooth.enable = true;
  services.dbus.enable = true;

  systemd.enableEmergencyMode = false;
  systemd.services."serial-getty@ttyS0".enable = false;
  systemd.services."serial-getty@hvc0".enable = false;
  systemd.services."getty@tty1".enable = false;
  systemd.services."autovt@".enable = false;

  documentation.enable = false;
  programs.command-not-found.enable = false;

  boot.plymouth.enable = true;
  boot.kernelParams = [ "rd.udev.log_priority=3" "vt.global_cursor_default=0" ];
}
