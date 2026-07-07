{
  config,
  lib,
  pkgs,
  ...
}:
with lib;
let
  cfg = config.services.kiosk;
  kioskProgram = pkgs.writeShellScript "kiosk-firefox" ''
    ${optionalString cfg.container ''
      until ${pkgs.curl}/bin/curl --fail --silent --show-error --max-time 2 --output /dev/null ${escapeShellArg cfg.url}; do
        ${pkgs.coreutils}/bin/sleep 2
      done
    ''}

    exec ${pkgs.firefox}/bin/firefox --kiosk --private-window ${escapeShellArg cfg.url}
  '';
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
      default = "http://localhost:${toString cfg.hostPort}";
    };

    container = mkOption {
      type = types.bool;
      default = false;
    };

    public = mkOption {
      type = types.bool;
      default = false;
      description = "Bind the container port to 0.0.0.0 instead of 127.0.0.1";
    };

    image = mkOption {
      type = types.str;
      default = "ghcr.io/jonpulsifer/hub:latest";
    };

    hostPort = mkOption {
      type = types.int;
      default = 8080;
    };

    containerPort = mkOption {
      type = types.int;
      default = 8080;
    };
  };

  config = mkIf cfg.enable {
    networking.firewall.allowedTCPPorts = mkIf cfg.public [ cfg.hostPort ];

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

    programs.xwayland.enable = mkForce false;

    services = {
      cage = {
        enable = true;
        package = pkgs.cage.override {
          wlroots_0_20 = pkgs.wlroots_0_20.override {
            enableXWayland = false;
          };
        };
        user = cfg.user;
        environment = {
          MOZ_ENABLE_WAYLAND = "1";
        };
        program = "${kioskProgram}";
      };
      xserver.enable = mkForce false;
    };

    systemd.services.cage-tty1 = mkIf cfg.container {
      after = [ "docker-kiosk.service" ];
      wants = [ "docker-kiosk.service" ];
    };

    virtualisation.docker.enable = mkIf cfg.container true;
    virtualisation.oci-containers = mkIf cfg.container {
      backend = "docker";
      containers.kiosk = {
        autoStart = true;
        image = cfg.image;
        ports = [
          "${
            if cfg.public then "0.0.0.0" else "127.0.0.1"
          }:${toString cfg.hostPort}:${toString cfg.containerPort}"
        ];
        environmentFiles = [ "/var/secrets/kiosk.env" ];
        environment = {
          PORT = toString cfg.containerPort;
        };
        user = "nobody:nogroup";
      };
    };

    services.dbus.enable = true;
  };
}
