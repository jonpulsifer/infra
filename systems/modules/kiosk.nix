{ config, lib, pkgs, ... }:
let
  kioskUser = "kiosk";
  kioskUrl = "https://grafana.lolwtf.ca/public-dashboards/3b8f687e2f14401b8cec93ce8c7e2d2f?refresh=10s";
  autostart = ''
    #!${pkgs.bash}/bin/bash
    xset dpms force on
    xset -dpms &
    xset s noblank &
    xset s off &
    # https://developer.mozilla.org/en-US/docs/Mozilla/Command_Line_Options
    ${pkgs.firefox}/bin/firefox --kiosk ${kioskUrl} &
  '';
in
{
  boot.kernelParams = [ "nomodeset" ];
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

  services.xserver = {
    enable = true;
    monitorSection = ''
      Option   "NODPMS"
    '';
    serverLayoutSection = ''
      Option   "BlankTime" "0"
      Option   "DPMS" "false"
    '';
    config = ''
      Section "ServerFlags"
        Option  "DontVTSwitch"  "True"
      EndSection
    '';
    desktopManager = {
      xterm.enable = false;
    };
    displayManager = {
      autoLogin = {
        enable = true;
        user = kioskUser;
      };
      defaultSession = "none+openbox";
      lightdm = {
        enable = true;
        greeter.enable = false;
      };
    };
    windowManager.openbox.enable = true;
  };
  environment.etc."openbox/autostart".source = pkgs.writeScript "autostart" autostart;
  nixpkgs.overlays = with pkgs; [
    (final: prev: {
      openbox = prev.openbox.overrideAttrs (oldAttrs: rec {
        postFixup = ''
          ln -sf /etc/openbox/autostart $out/etc/xdg/openbox/autostart
        '';
      });
    })
  ];
  hardware.opengl.enable = true;
  services.dbus.enable = true;
}