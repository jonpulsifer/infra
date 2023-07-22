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
    surf
    i3status
  ];

  services.xserver = {
    enable = true;
    config = ''
      Section "ServerFlags"
        Option  "DontVTSwitch"  "True"
      EndSection
    '';
    desktopManager = {
      default = "none";
      xterm.enable = false;
    };
    displayManager = {
      lightdm = {
        enable = true;
        greeter.enable = false;
        autoLogin.enable = true;
        autoLogin.user = "mudrii";
      };
    };
    windowManager = {
      default = "i3";
      i3.enable = true;
      i3.configFile = pkgs.writeText "config" ''
        set $mod Mod4
        new_window 1pixel
        for_window [class="Surf"] fullscreen
        exec surf -k "https://www.google.com/"
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

  services.udisks2.enable = false;
  documentation.enable = false;
  powerManagement.enable = false;
  programs.command-not-found.enable = false;

  boot.plymouth.enable = true;
  boot.kernelParams = [ "rd.udev.log_priority=3" "vt.global_cursor_default=0" ];
}
