# Makes a fleet host a bosun host: it keeps a warm pool of skiffs, each an
# ephemeral microVM serving exactly one GitHub Actions job.
#
# Nothing in the skiff data path needs root. virtiofsd runs with
# `--sandbox namespace`, passt runs unprivileged, and /dev/kvm is a group
# membership -- so bosun is an ordinary system user. What it does need is the
# egress filter below, which every skiff inherits.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib)
    mkEnableOption
    mkIf
    mkOption
    types
    ;
  cfg = config.services.bosun;

  configFile = (pkgs.formats.json { }).generate "bosun.json" {
    inherit (cfg)
      repo
      tokenFile
      runtimeDir
      logDir
      ;
    pollInterval = cfg.pollInterval;
    classes = lib.mapAttrs (_: c: {
      inherit (c)
        hull
        vcpus
        memory
        warm
        maxLifetime
        ;
    }) cfg.classes;
    bin = {
      cloudHypervisor = lib.getExe' pkgs.cloud-hypervisor "cloud-hypervisor";
      virtiofsd = "${pkgs.virtiofsd}/bin/virtiofsd";
      passt = lib.getExe' pkgs.passt "passt";
    };
  };
in
{
  # nixpkgs ships an unrelated `services.bosun` (Stack Exchange's monitoring
  # daemon) and an unrelated `pkgs.bosun` to go with it. The fleet will never
  # run either, so the name is claimed here rather than the project renamed.
  disabledModules = [ "services/monitoring/bosun.nix" ];

  options.services.bosun = {
    enable = mkEnableOption "the bosun warm pool of microVM Actions runners";

    package = mkOption {
      type = types.package;
      default = pkgs.callPackage ./package.nix { };
      defaultText = lib.literalExpression "pkgs.callPackage ./package.nix { }";
      description = ''
        The daemon. Not taken from an overlay: nixpkgs already has an
        unrelated `bosun`, and shadowing it fleet-wide to reach this one is a
        worse trade than naming it here.
      '';
    };

    repo = mkOption {
      type = types.str;
      description = "owner/name of the repository skiffs register against.";
    };

    tokenFile = mkOption {
      type = types.path;
      description = ''
        File holding a GitHub token with `Administration: write` on
        {option}`services.bosun.repo`, which is what minting a JIT config
        requires. Read once at startup and never logged.
      '';
    };

    runtimeDir = mkOption {
      type = types.str;
      default = "/run/bosun";
      description = ''
        Per-skiff state and vhost-user sockets. Keep it short: these paths go
        into AF_UNIX addresses, which are capped at 108 bytes, and an
        over-long one produces a VM that silently never starts.
      '';
    };

    logDir = mkOption {
      type = types.str;
      default = "/var/log/bosun";
      description = "Where each skiff's serial console is written.";
    };

    pollInterval = mkOption {
      type = types.str;
      default = "30s";
      description = ''
        How often to ask GitHub whether a skiff's runner is online and busy.
        One request per skiff, by id -- never the runner list, which carries
        ghosts from registrations no skiff ever consumed.
      '';
    };

    classes = mkOption {
      description = ''
        What a `runs-on:` label resolves to. The attribute name is the label,
        so a workflow writing `runs-on: skiff-nixos` reaches the class named
        `skiff-nixos`.
      '';
      default = { };
      type = types.attrsOf (
        types.submodule {
          options = {
            hull = mkOption {
              type = types.str;
              description = "Directory holding hull.json and the artifacts it names.";
            };
            vcpus = mkOption {
              type = types.ints.positive;
              default = 4;
            };
            memory = mkOption {
              type = types.str;
              default = "4096M";
            };
            warm = mkOption {
              type = types.ints.unsigned;
              default = 1;
              description = ''
                How many skiffs of this class to keep booted and registered.
                Each holds its memory for as long as it idles, so this is
                bounded by RAM rather than by cores.
              '';
            };
            maxLifetime = mkOption {
              type = types.str;
              default = "1h";
              description = ''
                Budget for a skiff once its runner goes busy. Measured from
                the busy transition, not from boot -- otherwise time spent
                waiting in the warm pool eats the job's budget.
              '';
            };
          };
        }
      );
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.classes != { };
        message = "services.bosun.classes is empty: bosun would boot nothing.";
      }
    ];

    boot.kernelModules = [ "kvm-intel" ];

    # Restoring a snapshot with memory_restore_mode=ondemand needs this, and
    # it defaults to 0. Harmless otherwise.
    boot.kernel.sysctl."vm.unprivileged_userfaultfd" = 1;

    users.users.bosun = {
      isSystemUser = true;
      group = "bosun";
      # /dev/kvm is a group membership, not root.
      extraGroups = [ "kvm" ];
    };
    users.groups.bosun = { };

    systemd.services.bosun = {
      description = "warm pool of ephemeral microVM Actions runners";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      path = [
        pkgs.cloud-hypervisor
        pkgs.virtiofsd
        pkgs.passt
      ];

      serviceConfig = {
        ExecStart = "${lib.getExe' cfg.package "bosun"} -config ${configFile}";
        User = "bosun";
        Group = "bosun";
        SupplementaryGroups = [ "kvm" ];
        # always, not on-failure: bosun exits 0 on SIGTERM, and on-failure
        # reads that as "done" -- leaving the pool empty and every skiff label
        # unserviced until someone notices. An explicit `systemctl stop` still
        # stops it.
        Restart = "always";
        RestartSec = "5s";

        RuntimeDirectory = "bosun";
        RuntimeDirectoryMode = "0700";
        # systemd removes a RuntimeDirectory when the service stops, which
        # would delete the per-skiff state on the way down -- exactly what
        # sweep-on-start reads to deregister runners whose VMM was killed with
        # the cgroup and never got to tear itself down. Without this, every
        # restart leaks a ghost registration.
        RuntimeDirectoryPreserve = "yes";
        LogsDirectory = "bosun";

        # Every skiff is a child of this unit, so one filter covers the whole
        # pool: job code reaches the public internet and nothing on the LAN.
        # systemd's IP filtering is hierarchical and inherits down the entire
        # cgroup subtree, which is why there is no per-skiff rule anywhere.
        IPAddressAllow = "any";
        IPAddressDeny = [
          "10.0.0.0/8"
          "172.16.0.0/12"
          "192.168.0.0/16"
          "169.254.0.0/16"
        ];

        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        # DeviceAllow is a whitelist once set: naming /dev/kvm denies the rest.
        DevicePolicy = "closed";
        DeviceAllow = [ "/dev/kvm rw" ];
      };
    };
  };
}
