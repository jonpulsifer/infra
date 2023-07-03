{ config, pkgs, ... }:
let
  autostart = ''
    #!${pkgs.bash}/bin/bash
    # End all lines with '&' to not halt startup script execution

    firefox --kiosk https://headerz.lolwtf.ca/ &
  '';

  inherit (pkgs) writeScript;
in
{
  services.xserver = {
    enable = true;
    layout = "us"; # keyboard layout
    libinput.enable = true;

    # Let lightdm handle autologin
    displayManager.lightdm = {
      enable = true;
      # autoLogin = {
      #   timeout = 0;
      # };
    };

    # Start openbox after autologin
    windowManager.openbox.enable = true;
    displayManager = {
      defaultSession = "none+openbox";
      autoLogin = {
        inherit user;
        enable = true;
      };
    };
  };

  systemd.services."display-manager".after = [
    "network-online.target"
    "systemd-resolved.service"
  ];

  # Overlay to set custom autostart script for openbox
  nixpkgs.overlays = with pkgs; [
    (_self: super: {
      openbox = super.openbox.overrideAttrs (_oldAttrs: rec {
        postFixup = ''
          ln -sf /etc/openbox/autostart $out/etc/xdg/openbox/autostart
        '';
      });
    })
  ];

  # By defining the script source outside of the overlay, we don't have to
  # rebuild the package every time we change the startup script.
  environment.etc."openbox/autostart".source = writeScript "autostart" autostart;

  users.users.kiosk = {
    isNormalUser = true;
    openssh.authorizedKeys.keys = config.users.users.jawn.openssh.authorizedKeys.keys;
    extraGroups = [ "tty" ];
    shell = pkgs.zsh;
  };
  # services.cage = {
  #   enable = true;
  #   user = "kiosk";
  #   program = "${pkgs.firefox}/bin/firefox -kiosk -private-window https://headerz.lolwtf.ca";
  # };
  systemd.services."getty@tty1".enable = false;
  systemd.services."autovt@".enable = false;
}
