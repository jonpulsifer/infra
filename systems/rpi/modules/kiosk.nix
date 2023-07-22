{ config, lib, pkgs, ... }:
let
  kioskUser = "kiosk";
  kioskUrl = "https://headerz.lolwtf.ca";
  autostart = ''
    #!${pkgs.bash}/bin/bash
    # End all lines with '&' to not halt startup script execution

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

  environment.systemPackages = with pkgs; [
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
    (self: super: {
      openbox = super.openbox.overrideAttrs (oldAttrs: rec {
        postFixup = ''
          ln -sf /etc/openbox/autostart $out/etc/xdg/openbox/autostart
        '';
      });
    })
  ];
  hardware.opengl.enable = true;
  hardware.bluetooth.enable = true;
  services.dbus.enable = true;

  systemd.enableEmergencyMode = false;
  documentation.enable = false;
  programs.command-not-found.enable = false;
}
