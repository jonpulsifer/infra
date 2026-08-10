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
    drainTimeout = "${toString cfg.drainTimeout}s";
    cacheUrl = if cfg.cache.enable then "http://${cfg.cache.address}:${toString cfg.cache.port}/" else "";
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
    spindrift =
      if cfg.spindrift == null then
        null
      else
        {
          inherit (cfg.spindrift) url tokenFile classes;
          pollInterval = cfg.spindrift.pollInterval;
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

    drainTimeout = mkOption {
      # positive, not unsigned: 0 would read as "stop immediately" but the
      # daemon treats a non-positive value as unset and drains for the 15 min
      # default anyway, while TimeoutStopSec would drop to 60 -- a stop that
      # ends in a cgroup SIGKILL mid-drain. The immediate-stop spelling is
      # `systemctl kill bosun`, not a zero here.
      type = types.ints.positive;
      default = 900;
      description = ''
        Seconds a stop waits for busy skiffs to finish their jobs. Idle
        skiffs are scuttled immediately, registration first, so no job can
        land on one mid-drain; at the deadline whatever is still busy is
        killed. A stop is what every deploy and token rotation does to this
        unit, so this is also how long `nixos-rebuild switch` may block on
        this host -- the price of a deploy no longer failing every in-flight
        job. Must exceed the longest job this host's classes are expected to
        run; a wedged busy guest is reaped earlier by its class's
        `maxLifetime` where that is shorter.

        The unit's TimeoutStopSec is derived from this with a minute of
        slack, so systemd's cgroup SIGKILL stays the backstop rather than
        the mechanism.
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

    spindrift = mkOption {
      default = null;
      description = ''
        Turns this host into a Spindrift build source alongside its GitHub
        warm pool: bosun long-polls {option}`spindrift.url` for a build
        request in one of {option}`spindrift.classes`, boots a skiff of that
        class with the request written into its share instead of a JIT
        config, and posts the result back once the skiff halts. null (the
        default) means this host never talks to Spindrift.

        A class serving builds should set its own `warm = 0`: a build skiff
        boots on claim rather than ahead of time the way a GitHub-registered
        skiff does, so keeping one warm buys nothing.
      '';
      type = types.nullOr (
        types.submodule {
          options = {
            url = mkOption {
              type = types.str;
              description = "Base URL of the Spindrift instance whose outbox this host claims builds from.";
            };
            tokenFile = mkOption {
              type = types.path;
              description = "File holding the bearer token bosun authenticates to Spindrift with.";
            };
            classes = mkOption {
              type = types.listOf types.str;
              description = ''
                Which of {option}`classes` this host claims builds for. Every
                entry must also be declared there.
              '';
            };
            pollInterval = mkOption {
              type = types.str;
              default = "30s";
              description = ''
                Wait before retrying after a failed claim. Not the poll
                cadence itself -- the claim call long-polls Spindrift
                server-side, so a successful round trip is the wait.
              '';
            };
          };
        }
      );
    };

    # A GitHub-Actions cache service on this host's own disk, announced to
    # every skiff as `bosun.cache=<url>` on the cmdline. The Ubuntu hull
    # patches its runner so the stock actions/cache action talks to it
    # instead of GitHub's cache service -- the bench measured 49-76 s of
    # `actions/cache` restore over the internet against 0 s from local disk,
    # and this is that number for workflows that were never taught about
    # SKIFF_CACHE.
    #
    # The server binds a dummy interface that exists only for this purpose,
    # and the skiffs' egress filter gains exactly that /32: systemd's most-
    # specific-match rule lets it through the RFC1918 deny without opening
    # the host's real address, its loopback, or anything else on the LAN.
    # The server itself validates each runner's GitHub-signed JWT against
    # GitHub's JWKS, so an address is all a caller gets, not a cache.
    cache = {
      enable = mkEnableOption "a host-local GitHub Actions cache service for the skiffs";

      address = mkOption {
        type = types.str;
        default = "10.113.113.1";
        description = ''
          Host-local dummy address the cache service binds. Deliberately
          inside RFC1918 so it stays unroutable beyond this host; chosen
          away from every declared fabric range.
        '';
      };

      port = mkOption {
        type = types.port;
        default = 3000;
      };

      storageDir = mkOption {
        type = types.path;
        default = "/var/lib/bosun-cache";
        description = "Cache payloads and the sqlite metadata DB live here.";
      };

      maxSizeBytes = mkOption {
        type = types.nullOr types.int;
        default = null;
        description = ''
          LRU-eviction cap on stored cache payloads. null leaves only the
          server's own 90% volume-usage guard.
        '';
      };

      image = mkOption {
        type = types.str;
        default = "ghcr.io/falcondev-oss/github-actions-cache-server:9.7.0";
        description = ''
          Pinned server image. v9+ speaks only the v2 twirp protocol, which
          is what actions/cache >= 4.2 uses against github.com.
        '';
      };
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
    ]
    ++ lib.optional cfg.cache.enable "d ${cfg.cache.storageDir} 0700 root root -";

    # The dummy interface the cache service binds. A netdev with no carrier
    # and no routes beyond the host: the address exists so the skiffs' egress
    # exception can name exactly one /32 that serves nothing but cache.
    systemd.network.netdevs."20-bosun-cache" = mkIf cfg.cache.enable {
      netdevConfig = {
        Name = "bosun-cache0";
        Kind = "dummy";
      };
    };
    systemd.network.networks."20-bosun-cache" = mkIf cfg.cache.enable {
      matchConfig.Name = "bosun-cache0";
      address = [ "${cfg.cache.address}/32" ];
      linkConfig.ActivationPolicy = "always-up";
    };

    virtualisation.oci-containers = mkIf cfg.cache.enable {
      backend = "podman";
      containers.bosun-cache = {
        image = cfg.cache.image;
        # Published on the dummy address only: the host's real interfaces
        # never listen, so nothing off-host can reach the server even before
        # any firewall has an opinion.
        ports = [ "${cfg.cache.address}:${toString cfg.cache.port}:3000" ];
        volumes = [ "${cfg.cache.storageDir}:/data" ];
        environment = {
          API_BASE_URL = "http://${cfg.cache.address}:${toString cfg.cache.port}";
          STORAGE_FILESYSTEM_PATH = "/data/storage";
          DB_SQLITE_PATH = "/data/cache-server.db";
        }
        // lib.optionalAttrs (cfg.cache.maxSizeBytes != null) {
          CACHE_MAX_SIZE_BYTES = toString cfg.cache.maxSizeBytes;
        };
      };
    };

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

        # Drain needs the stop signal to reach the daemon alone: the default
        # KillMode=control-group SIGTERMs every process in the cgroup at
        # stop, killing the very VMMs drain exists to let finish. mixed still
        # SIGKILLs the whole cgroup at the timeout, so the no-orphans
        # guarantee stands -- the backstop moved, the mechanism changed.
        #
        # The trade lives on the crash path: when the daemon dies uncleanly
        # with skiffs booted, nothing SIGTERMs the surviving VMMs, so the
        # restart waits out the full stop timeout while the orphaned runners
        # keep serving jobs on their own -- a crash costs minutes of stale
        # pool where control-group killed everything in seconds. A startup
        # crash loop boots no VMMs and still cycles at RestartSec.
        KillMode = "mixed";
        TimeoutStopSec = cfg.drainTimeout + 60;

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
        # "any" is /0 and systemd's most-specific-match rule means the deny
        # prefixes below still bite; the cache /32, when enabled, is more
        # specific than 10.0.0.0/8 and punches exactly one host-local hole.
        IPAddressAllow = [ "any" ] ++ lib.optional cfg.cache.enable "${cfg.cache.address}/32";
        IPAddressDeny = [
          "10.0.0.0/8"
          "172.16.0.0/12"
          "192.168.0.0/16"
          # Link-local, which is where a cloud metadata service lives.
          "169.254.0.0/16"
          # The tailnet. RFC1918 is not the whole LAN on a host that runs
          # tailscale -- every enrolled fleet host also answers on a CGNAT
          # address, and reaching one is reaching the homelab. riptide force-
          # disables tailscale so this never bit there; a `gcp`-tagged host
          # does not.
          "100.64.0.0/10"
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
