{
  config,
  lib,
  pkgs,
  ...
}:
with lib;
let
  cfg = config.services.kiosk;
in
{
  options.services.kiosk = {
    enable = mkEnableOption "kiosk service";
    user = mkOption {
      type = types.str;
      default = "kiosk";
    };
    url = mkOption {
      type = types.str;
      default = "https://hub.lolwtf.ca";
    };
  };

  config = mkIf cfg.enable {
    boot.kernelParams = [ "nomodeset" ];

    hardware = {
      graphics.enable = true;
      raspberry-pi."4".touch-ft5406.enable = true;
      raspberry-pi."4".fkms-3d.enable = true;
    };

    users.users.${cfg.user} = {
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

    services.displayManager = {
      autoLogin = {
        enable = true;
        user = cfg.user;
      };
      defaultSession = "none+openbox";
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
        lightdm = {
          enable = true;
          greeter.enable = false;
        };
      };
      windowManager.openbox.enable = true;
    };
    environment.etc."openbox/autostart".source = pkgs.writeScript "autostart" ''
      #!${pkgs.bash}/bin/bash
      xset dpms force on
      xset -dpms &
      xset s noblank &
      xset s off &
      # https://developer.mozilla.org/en-US/docs/Mozilla/Command_Line_Options
      ${pkgs.firefox}/bin/firefox --kiosk ${cfg.url} &
    '';

    nixpkgs.overlays = with pkgs; [
      (final: prev: {
        openbox = prev.openbox.overrideAttrs (oldAttrs: rec {
          postFixup = ''
            ln -sf /etc/openbox/autostart $out/etc/xdg/openbox/autostart
          '';
        });
      })
    ];
    services.dbus.enable = true;
  };
}
