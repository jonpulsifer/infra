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
      workspaceDir
      metricsFile
      ;
    pollInterval = cfg.pollInterval;
    classes = lib.mapAttrs (_: c: {
      inherit (c)
        hull
        vcpus
        memory
        workspace
        persist
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
      description = ''
        Where each skiff's serial console is written, and where its
        `<id>.diag/` — the guest's own runner trace, shared in writable — is
        left behind after the skiff is gone. Both survive retire on purpose;
        {option}`logRetention` is what bounds them.
      '';
    };

    workspaceDir = mkOption {
      type = types.str;
      default = "/var/lib/bosun/workspace";
      description = ''
        Where per-skiff scratch disks are reserved, for classes that size one
        with {option}`classes.<name>.workspace`. Must be real storage, not
        tmpfs: the whole point is to stop charging a build's bytes against the
        class's memory. Each image is fully allocated at boot, so
        `warm × workspace` per class is the space this host must keep free.

        An image is deleted when its skiff is scuttled unless the class sets
        {option}`classes.<name>.persist`, which hands it to the replacement
        instead. Either way the space is reserved up front, so the figure above
        does not change.
      '';
    };

    logRetention = mkOption {
      type = types.str;
      default = "7d";
      description = ''
        How long a scuttled skiff's serial console and diagnostic directory
        stay readable. Nothing else deletes them: retire keeps them so a
        skiff that died mid-job can still be read afterwards, and the
        diagnostic share is writable by untrusted job code.
      '';
    };

    metricsFile = mkOption {
      type = types.str;
      default = "/var/lib/prometheus-node-exporter-text-files/bosun.prom";
      description = ''
        Prometheus textfile for node-exporter's textfile collector to serve.
        Empty disables it.

        A file rather than an HTTP listener on purpose: the IPAddressDeny
        below is inherited by every skiff, so a socket in-cluster Prometheus
        could reach would mean opening the pod CIDR to untrusted job code
        too. The file's mtime is bosun's heartbeat -- node-exporter exports it
        as `node_textfile_mtime_seconds`, so a stale file is what a dead or
        wedged bosun looks like.
      '';
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
            workspace = mkOption {
              type = types.str;
              default = "";
              example = "6G";
              description = ''
                Size of a scratch disk handed to each skiff of this class, or
                empty for none. Both hull families put the guest root on a
                tmpfs overlay, so without one a class's {option}`memory` is
                also its disk budget and a checkout that outgrows it is an OOM
                rather than an ENOSPC.

                The disk is raw: what filesystem it carries is the hull's
                business, and bosun never learns what was written to it.
              '';
            };
            persist = mkOption {
              type = types.bool;
              default = false;
              description = ''
                Hand the same workspace disks back to successive skiffs of this
                class instead of a freshly reserved one each boot. Needs
                {option}`workspace`.

                This is the one place a skiff is allowed to leave something
                behind, and it is a deliberate trade rather than an oversight.
                What it buys is the entire measured deficit to a GitHub-hosted
                runner: on this repo's real suite that gap was 99 s, of which
                70 s was `actions/cache` pulling a dependency store over the
                internet — not compute, and not boot. A disk the next skiff
                finds already warm removes the transfer instead of speeding it
                up.

                What it costs is that one job can affect the next one on the
                same slot. The VM boundary still holds — a skiff cannot reach
                the host, another skiff, or the LAN — so what is shared is a
                filesystem, not a machine. That is the trade every
                non-ephemeral self-hosted runner makes, and it is only sound
                for a repository whose contributors are trusted. Leave it off
                for anything that runs code from a fork.

                Slot images are named `<class>-<slot>.img` under
                {option}`workspaceDir` and survive a bosun restart, which
                happens on every token rotation and every rebuild of this host.
                Lowering {option}`warm` reclaims the images above the new count
                on the next start. A guest that finds its disk nearly full
                reformats it, so a cache that grows without bound costs one
                cold job rather than an ENOSPC on every job after it.
              '';
            };
            warm = mkOption {
              type = types.ints.unsigned;
              default = 1;
              description = ''
                How many skiffs of this class to keep booted and registered.
                Each holds its memory for as long as it idles, so this is
                bounded by RAM rather than by cores — and by disk too, once
                {option}`workspace` is set, since that space is reserved up
                front rather than as a build uses it.
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

    # Nothing in bosun deletes a retired skiff's logs, so this is the only
    # bound on logDir: one directory per skiff ever booted, plus whatever job
    # code chose to write into the diagnostic share.
    #
    # The workspace directory is tmpfiles' rather than a second
    # StateDirectory=, because StateDirectoryMode is per-unit and the metrics
    # directory below has to stay 0755 for node-exporter while a skiff's
    # scratch disk should not be readable by anything else on the host.
    systemd.tmpfiles.rules = [
      "e ${cfg.logDir} - - - ${cfg.logRetention}"
      "d ${cfg.workspaceDir} 0700 bosun bosun -"
    ];

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
        # Holds metricsFile. 0755 so node-exporter -- which reads it from
        # outside this unit, as a DaemonSet mounting the host path -- can.
        #
        # The directory name is the fleet's, not bosun's:
        # nix/services/spore-native-boot.nix already drops a .prom file here.
        # ponytail: StateDirectory chowns it to bosun, so one writer per host.
        # A second host service wanting the same directory wants tmpfiles and
        # an explicit ReadWritePaths instead.
        StateDirectory = "prometheus-node-exporter-text-files";
        StateDirectoryMode = "0755";

        # ProtectSystem=strict makes everything outside the unit's own
        # runtime/state/logs read-only, and the workspace directory is neither.
        ReadWritePaths = [ cfg.workspaceDir ];

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
