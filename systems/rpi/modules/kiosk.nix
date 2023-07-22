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

  # services.cage = {
  #   enable = true;
  #   user = kioskUser;
  #   # extraArguments = [ "-d" ];
  #   program = "${pkgs.firefox}/bin/firefox -kiosk -private-window ${kioskUrl}";
  # };

  #################
  # NIXIOSK
  #################
  hardware.opengl.enable = true;
  hardware.bluetooth.enable = true;
  sound.enable = true;
  hardware.pulseaudio.enable = true;
  services.dbus.enable = true;

  # theming
  gtk.iconCache.enable = true;
  environment.systemPackages = [
    pkgs.gnome3.adwaita-icon-theme
    pkgs.hicolor-icon-theme

    (pkgs.git.override {
      withManual = false;
      pythonSupport = false;
      withpcre2 = false;
      perlSupport = false;
    })
  ];

  # input
  services.udev.packages = [ pkgs.libinput.out ];


  systemd.services."cage@" = {
    serviceConfig.Restart = "always";
    environment = {
      WLR_LIBINPUT_NO_DEVICES = "1";
      NO_AT_BRIDGE = "1";
      COG_URL = "https://duckduckgo.com"; # used if no url is specified
    };
  };

  systemd.enableEmergencyMode = false;
  systemd.services."serial-getty@ttyS0".enable = false;
  systemd.services."serial-getty@hvc0".enable = false;
  systemd.services."getty@tty1".enable = false;
  systemd.services."autovt@".enable = false;

  services.udisks2.enable = false;
  documentation.enable = false;
  powerManagement.enable = false;
  programs.command-not-found.enable = false;

  services.cage = {
    enable = true;
    user = "kiosk";
  };

  services.avahi = {
    enable = true;
    nssmdns = true;
    publish = {
      enable = true;
      userServices = true;
      addresses = true;
      hinfo = true;
      workstation = true;
      domain = true;
    };
  };
  environment.etc."avahi/services/ssh.service" = {
    text = ''
      <?xml version="1.0" standalone='no'?><!--*-nxml-*-->
      <!DOCTYPE service-group SYSTEM "avahi-service.dtd">
      <service-group>
        <name replace-wildcards="yes">%h</name>
        <service>
          <type>_ssh._tcp</type>
          <port>22</port>
        </service>
      </service-group>
    '';
  };

  nixpkgs = {
    overlays = [
      (self: super: {
        grub2 = super.grub2.override { zfsSupport = false; };

        cog = super.cog.overrideAttrs (o: {
          cmakeFlags = (o.cmakeFlags or [ ]) ++ [ "-DCOG_DBUS_SYSTEM_BUS=ON" "-DCOG_DBUS_OWN_USER=kiosk" ];
        });

        libinput = super.libinput.override (o: {
          documentationSupport = false;
          python3 = null;
        });
      })
    ];
  };

  boot.plymouth.enable = true;
  boot.kernelParams = [ "rd.udev.log_priority=3" "vt.global_cursor_default=0" ];

  networking.dhcpcd.extraConfig = ''
    timeout 0
    noarp
  '';

  security.polkit.extraConfig = ''
        polkit.addRule(function(action, subject) {
          if (action.id == "org.freedesktop.login1.power-off" ||
    	        action.id == "org.freedesktop.login1.reboot") {
            return polkit.Result.YES;
          }
        });
  '';

}
