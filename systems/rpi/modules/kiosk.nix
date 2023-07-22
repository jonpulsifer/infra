{ config, pkgs, ... }:
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
    } // lib.optionalAttrs (config.environment.variables ? GDK_PIXBUF_MODULE_FILE) {
      GDK_PIXBUF_MODULE_FILE = config.environment.variables.GDK_PIXBUF_MODULE_FILE;
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

      # Disable some things that don’t cross compile
      (self: super: lib.optionalAttrs (super.stdenv.hostPlatform != super.stdenv.buildPlatform) {
        gtk3 = super.gtk3.override { cupsSupport = false; };
        webkitgtk = super.webkitgtk.override {
          enableGeoLocation = false;
          stdenv = super.stdenv;
        };
        gst_all_1 = super.gst_all_1 // {
          gst-plugins-good = null;
          gst-plugins-bad = null;
          gst-plugins-ugly = null;
          gst-libav = null;
        };

        # cython pulls in target-specific gdb
        python37 = super.python37.override {
          packageOverrides = self: super: { cython = super.cython.override { gdb = null; }; };
        };

        # doesn’t cross compile
        libass = super.libass.override { encaSupport = false; };
        libproxy = super.libproxy.override { networkmanager = null; };
        enchant2 = super.enchant2.override { hspell = null; };
        cage = super.cage.override { xwayland = null; };

        alsaPlugins = super.alsaPlugins.override { libjack2 = null; };
        fluidsynth = super.fluidsynth.override { libjack2 = null; };
        portaudio = super.portaudio.override { libjack2 = null; };

        ffmpeg_4 = super.ffmpeg_4.override ({
          sdlSupport = false;
          # some ffmpeg libs are compiled with neon which rpi0 doesn’t support
        } // lib.optionalAttrs (super.stdenv.hostPlatform.parsed.cpu.name == "armv6l") {
          libopus = null;
          x264 = null;
          x265 = null;
          soxr = null;
        });
        ffmpeg = super.ffmpeg.override ({
          sdlSupport = false;
        } // lib.optionalAttrs (super.stdenv.hostPlatform.parsed.cpu.name == "armv6l") {
          libopus = null;
          x264 = null;
          x265 = null;
          soxr = null;
        });

        mesa = super.mesa.override { eglPlatforms = [ "wayland" ]; };

        busybox-sandbox-shell = super.busybox-sandbox-shell.override { inherit (super) busybox; };

      })
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
