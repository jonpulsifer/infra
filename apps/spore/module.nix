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
  cfg = config.services.spore;

  profileType = types.submodule {
    options = {
      name = mkOption { type = types.str; };
      description = mkOption {
        type = types.str;
        default = "";
      };
      content = mkOption { type = types.lines; };
    };
  };
  scriptType = types.submodule {
    options = {
      description = mkOption {
        type = types.str;
        default = "";
      };
      content = mkOption { type = types.lines; };
    };
  };
  hostType = types.submodule {
    options = {
      hostname = mkOption { type = types.str; };
      profile = mkOption { type = types.str; };
    };
  };
  nativeBootTargetType = types.submodule {
    options = {
      hostname = mkOption { type = types.str; };
      protocol = mkOption {
        type = types.enum [ "raspberry-pi-http" ];
        default = "raspberry-pi-http";
      };
    };
  };
  nativeBootArtifactType = types.submodule {
    options = {
      package = mkOption { type = types.package; };
      signingKey = mkOption {
        type = types.str;
        description = "Runtime path to the private key used to sign boot.img.";
      };
    };
  };

  catalogData = {
    inherit (cfg.catalog)
      serverOrigin
      allowUnknownHosts
      defaultProfile
      profiles
      scripts
      hosts
      nativeBootTargets
      ;
  };
  json = pkgs.formats.json { };
  baseCatalogFile = json.generate "spore-catalog-base.json" catalogData;
  catalogFile =
    if cfg.catalog.hostsSource == null then
      baseCatalogFile
    else
      pkgs.runCommand "spore-catalog.json"
        {
          nativeBuildInputs = [
            pkgs.jq
            pkgs.yj
          ];
        }
        ''
          ${lib.getExe pkgs.yj} -yj < ${cfg.catalog.hostsSource} > clients.json
          ${lib.getExe pkgs.jq} \
            --slurpfile catalog ${baseCatalogFile} \
            --arg group ${lib.escapeShellArg cfg.catalog.hostsSourceGroup} \
            --arg profile ${lib.escapeShellArg cfg.catalog.hostsSourceProfile} \
            --arg nativeGroup ${lib.escapeShellArg cfg.catalog.nativeBootTargetsSourceGroup} \
            '. as $clients | $catalog[0] + {
              hosts: ($catalog[0].hosts + ((.[$group] // {}) | to_entries | map({
                key: (.value.mac | ascii_downcase),
                value: { hostname: .key, profile: $profile }
              }) | from_entries)),
              nativeBootTargets: ($catalog[0].nativeBootTargets | with_entries(
                .value += { macAddress: ($clients[$nativeGroup][.key].mac | ascii_downcase) }
              ))
            }' clients.json > "$out"
        '';

  upstream = "http://${cfg.listenAddress}:${toString cfg.port}";
  nativePublisherUnits = map (id: "spore-native-boot-${id}.service") (
    builtins.attrNames cfg.nativeBootArtifacts
  );
  proxyLocation = {
    proxyPass = upstream;
    proxyWebsockets = false;
    extraConfig = ''
      limit_except GET {
        deny all;
      }
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-Proto $scheme;
    '';
  };
in
{
  options.services.spore = {
    enable = mkEnableOption "the Spore network-boot catalog and observation service";
    package = mkOption {
      type = types.package;
      default = pkgs.callPackage ./package.nix { };
      defaultText = lib.literalExpression "pkgs.callPackage ./apps/spore/package.nix { }";
    };
    user = mkOption {
      type = types.str;
      default = "spore";
    };
    group = mkOption {
      type = types.str;
      default = "spore";
    };
    listenAddress = mkOption {
      type = types.str;
      default = "127.0.0.1";
    };
    port = mkOption {
      type = types.port;
      default = 3000;
    };
    basePath = mkOption {
      type = types.strMatching "^/[A-Za-z0-9._~/-]+$";
      default = "/spore";
    };
    managementHost = mkOption {
      type = types.str;
      default = "spore.lolwtf.ca";
    };
    managementAliases = mkOption {
      type = types.listOf types.str;
      default = [ "spore.pirate-musical.ts.net" ];
      description = "Additional Tailscale-routable names for the protected management vhost.";
    };
    managementCidrs = mkOption {
      type = types.listOf types.str;
      default = [
        "127.0.0.0/8"
        "::1/128"
        "100.64.0.0/10"
      ];
    };
    expectedTailnet = mkOption {
      type = types.str;
      default = "pirate-musical.ts.net";
      description = "Optional tailnet domain required by nginx Tailscale authentication.";
    };
    backupRetentionDays = mkOption {
      type = types.ints.positive;
      default = 14;
    };
    catalog = {
      serverOrigin = mkOption { type = types.str; };
      allowUnknownHosts = mkOption {
        type = types.bool;
        default = false;
      };
      defaultProfile = mkOption { type = types.str; };
      profiles = mkOption {
        type = types.attrsOf profileType;
        default = { };
      };
      scripts = mkOption {
        type = types.attrsOf scriptType;
        default = { };
      };
      hosts = mkOption {
        type = types.attrsOf hostType;
        default = { };
      };
      nativeBootTargets = mkOption {
        type = types.attrsOf nativeBootTargetType;
        default = { };
      };
      hostsSource = mkOption {
        type = types.nullOr types.path;
        default = null;
        description = "Optional clients YAML used to derive host MACs without duplicating their SSOT.";
      };
      hostsSourceGroup = mkOption {
        type = types.str;
        default = "k8s";
      };
      hostsSourceProfile = mkOption {
        type = types.str;
        default = "k8s-node";
      };
      nativeBootTargetsSourceGroup = mkOption {
        type = types.str;
        default = "rpis";
        description = "Inventory group containing native boot target MAC addresses.";
      };
    };
    nativeBootArtifacts = mkOption {
      type = types.attrsOf nativeBootArtifactType;
      default = { };
      description = "Signed native boot artifacts published through Spore.";
    };
  };

  config = mkIf cfg.enable (
    lib.mkMerge [
      {
        assertions = [
          {
            assertion = builtins.elem cfg.listenAddress [
              "127.0.0.1"
              "::1"
            ];
            message = "services.spore.listenAddress must remain loopback-only";
          }
          {
            assertion = builtins.match "^https?://[^@/?#]+(/[^?#]*)?$" cfg.catalog.serverOrigin != null;
            message = "services.spore.catalog.serverOrigin must be an absolute HTTP(S) URL without query or fragment";
          }
          {
            assertion = lib.hasSuffix cfg.basePath cfg.catalog.serverOrigin;
            message = "services.spore.catalog.serverOrigin must end with services.spore.basePath";
          }
          {
            assertion = builtins.hasAttr cfg.catalog.defaultProfile cfg.catalog.profiles;
            message = "services.spore.catalog.defaultProfile must reference a configured profile";
          }
          {
            assertion = lib.all (host: builtins.hasAttr host.profile cfg.catalog.profiles) (
              builtins.attrValues cfg.catalog.hosts
            );
            message = "every services.spore.catalog.hosts profile must reference a configured profile";
          }
          {
            assertion = lib.all (profile: lib.hasPrefix "#!ipxe" profile.content) (
              builtins.attrValues cfg.catalog.profiles
            );
            message = "every services.spore.catalog.profiles content must begin with #!ipxe";
          }
          {
            assertion = lib.all (script: lib.hasPrefix "#!ipxe" script.content) (
              builtins.attrValues cfg.catalog.scripts
            );
            message = "every services.spore.catalog.scripts content must begin with #!ipxe";
          }
          {
            assertion = lib.all (
              path:
              builtins.match "^[A-Za-z0-9][A-Za-z0-9._/-]*$" path != null
              && !(lib.hasInfix "//" path)
              && !(lib.hasInfix "\\" path)
              && lib.all (segment: segment != "." && segment != "..") (lib.splitString "/" path)
            ) (builtins.attrNames cfg.catalog.scripts);
            message = "services.spore.catalog.scripts keys must be safe relative paths";
          }
          {
            assertion = lib.all (mac: builtins.match "^([0-9a-f]{2}:){5}[0-9a-f]{2}$" mac != null) (
              builtins.attrNames cfg.catalog.hosts
            );
            message = "services.spore.catalog.hosts keys must be normalized MAC addresses";
          }
          {
            assertion =
              cfg.catalog.hostsSource == null
              || builtins.hasAttr cfg.catalog.hostsSourceProfile cfg.catalog.profiles;
            message = "services.spore.catalog.hostsSourceProfile must reference a configured profile";
          }
          {
            assertion = cfg.catalog.nativeBootTargets == { } || cfg.catalog.hostsSource != null;
            message = "services.spore native boot targets require catalog.hostsSource for MAC identity";
          }
          {
            assertion =
              builtins.attrNames cfg.catalog.nativeBootTargets == builtins.attrNames cfg.nativeBootArtifacts;
            message = "services.spore native boot target policy and artifacts must have identical keys";
          }
        ];

        users.groups.${cfg.group} = { };
        users.users.${cfg.user} = {
          isSystemUser = true;
          group = cfg.group;
        };

        systemd.tmpfiles.rules = [
          "d /var/backup/spore 0750 ${cfg.user} ${cfg.group} -"
          "d /var/lib/spore-native-boot 0755 root root -"
        ];

        systemd.services.spore = {
          description = "Spore network-boot catalog and observation UI";
          wantedBy = [ "multi-user.target" ];
          requires = nativePublisherUnits;
          after = [ "network.target" ] ++ nativePublisherUnits;
          environment = {
            DATABASE_URL = "file:/var/lib/spore/observations.db";
            HOSTNAME = cfg.listenAddress;
            PORT = toString cfg.port;
            SPORE_CATALOG_FILE = toString catalogFile;
            SPORE_MIGRATIONS_DIR = "${cfg.package}/share/spore/migrations";
          };
          serviceConfig = {
            Type = "simple";
            User = cfg.user;
            Group = cfg.group;
            WorkingDirectory = "${cfg.package}/share/spore";
            # Observation state is optional for boot policy. The systemd '-' prefix
            # keeps a failed migration from preventing the catalog-backed service
            # from starting; health remains degraded until SQLite can open.
            ExecStartPre = "-${cfg.package}/bin/spore-migrate";
            ExecStart = "${cfg.package}/bin/spore";
            Restart = "on-failure";
            RestartSec = "5s";
            StateDirectory = "spore";
            StateDirectoryMode = "0750";
            NoNewPrivileges = true;
            PrivateDevices = true;
            PrivateTmp = true;
            ProtectClock = true;
            ProtectControlGroups = true;
            ProtectHome = true;
            ProtectKernelLogs = true;
            ProtectKernelModules = true;
            ProtectKernelTunables = true;
            ProtectSystem = "strict";
            ReadWritePaths = [ "/var/lib/spore" ];
            RestrictAddressFamilies = [
              "AF_UNIX"
              "AF_INET"
              "AF_INET6"
            ];
            RestrictNamespaces = true;
            RestrictRealtime = true;
            LockPersonality = true;
            MemoryDenyWriteExecute = false;
            CapabilityBoundingSet = "";
            SystemCallArchitectures = "native";
            UMask = "0027";
          };
        };

        systemd.services.spore-backup = {
          description = "Back up Spore boot observations";
          serviceConfig = {
            Type = "oneshot";
            User = cfg.user;
            Group = cfg.group;
            NoNewPrivileges = true;
            PrivateTmp = true;
            ProtectHome = true;
            ProtectSystem = "strict";
            ReadWritePaths = [
              "/var/lib/spore"
              "/var/backup/spore"
            ];
          };
          script = ''
            set -euo pipefail
            database=/var/lib/spore/observations.db
            if [ ! -f "$database" ]; then
              exit 0
            fi
            destination="/var/backup/spore/observations-$(${pkgs.coreutils}/bin/date -u +%Y%m%dT%H%M%SZ).db"
            ${pkgs.sqlite}/bin/sqlite3 "$database" "VACUUM INTO '$destination'"
            ${pkgs.findutils}/bin/find /var/backup/spore -type f -name 'observations-*.db' \
              -mtime +${toString cfg.backupRetentionDays} -delete
          '';
        };
        systemd.timers.spore-backup = {
          wantedBy = [ "timers.target" ];
          timerConfig = {
            OnCalendar = "daily";
            Persistent = true;
            RandomizedDelaySec = "1h";
          };
        };

        services.nginx.virtualHosts."spore-pxe".locations = {
          "${cfg.basePath}/api/boot/" = proxyLocation;
          "${cfg.basePath}/api/scripts/" = proxyLocation;
          "${cfg.basePath}/api/native-boot/" = proxyLocation;
        };
        services.nginx.virtualHosts.${cfg.managementHost} = {
          serverAliases = cfg.managementAliases;
          locations."/" = {
            proxyPass = upstream;
            proxyWebsockets = false;
            extraConfig = ''
              satisfy any;
            ''
            + lib.concatMapStringsSep "\n" (cidr: "allow ${cidr};") cfg.managementCidrs
            + ''

              deny all;
              proxy_set_header Host $host;
              proxy_set_header X-Forwarded-Proto $scheme;
            '';
          };
        };
        services.nginx.tailscaleAuth = {
          enable = true;
          expectedTailnet = cfg.expectedTailnet;
          virtualHosts = [ cfg.managementHost ];
        };
      }
      {
        systemd.services =
          (lib.mapAttrs' (
            id: artifact:
            lib.nameValuePair "spore-native-boot-${id}" {
              description = "Publish signed Spore native boot target ${id}";
              wantedBy = [ "multi-user.target" ];
              before = [
                "nginx.service"
                "spore.service"
              ];
              restartTriggers = [ artifact.package ];
              path = with pkgs; [
                coreutils
                gnugrep
                mtools
                raspberrypi-eeprom
              ];
              serviceConfig = {
                Type = "oneshot";
                RemainAfterExit = true;
                User = "root";
                Group = "root";
                UMask = "0022";
                NoNewPrivileges = true;
                PrivateDevices = true;
                PrivateTmp = true;
                ProtectClock = true;
                ProtectControlGroups = true;
                ProtectHome = true;
                ProtectKernelLogs = true;
                ProtectKernelModules = true;
                ProtectKernelTunables = true;
                ProtectSystem = "strict";
                ReadWritePaths = [ "/var/lib/spore-native-boot" ];
                RestrictAddressFamilies = [ "AF_UNIX" ];
                RestrictNamespaces = true;
                RestrictRealtime = true;
                LockPersonality = true;
                MemoryDenyWriteExecute = true;
                CapabilityBoundingSet = "";
                SystemCallArchitectures = "native";
              };
              script = ''
                set -euo pipefail

                source_image=${artifact.package}/boot.img
                source_store=${artifact.package}/nix-store.squashfs
                signing_key=${lib.escapeShellArg artifact.signingKey}
                state=/var/lib/spore-native-boot

                test -s "$source_image"
                test -s "$source_store"
                test -s "$signing_key"
                install -d -m 0755 "$state/releases"
                install -d -m 0755 "$state/stores"
                stage=$(mktemp -d "$state/releases/.${id}.XXXXXX")
                trap 'rm -rf "$stage"' EXIT

                install -m 0644 "$source_image" "$stage/boot.img"
                checksum=$(sha256sum "$source_store" | cut -d ' ' -f 1)
                mtype -i "$stage/boot.img@@512" ::/cmdline.txt \
                  | tr -d '\r' \
                  | grep -q "spore.squashfs-sha256=$checksum"

                rpi-eeprom-digest -i "$stage/boot.img" -o "$stage/boot.sig" -k "$signing_key"
                test -s "$stage/boot.sig"
                ln -s "$source_store" "$stage/nix-store.squashfs"
                ln -sfn "$source_store" "$state/stores/.${id}-$checksum.new"
                mv -Tf "$state/stores/.${id}-$checksum.new" "$state/stores/$checksum.squashfs"

                release_id=$(
                  {
                    printf '%s\n' "$checksum"
                    sha256sum "$stage/boot.img" "$stage/boot.sig"
                  } | sha256sum | cut -d ' ' -f 1
                )
                release="$state/releases/${id}-$release_id"
                if [ -e "$release" ]; then
                  rm -rf "$stage"
                else
                  mv "$stage" "$release"
                fi
                trap - EXIT
                ln -sfn "releases/${id}-$release_id" "$state/.${id}.new"
                mv -Tf "$state/.${id}.new" "$state/${id}"
              '';
            }
          ) cfg.nativeBootArtifacts)
          // {
            nginx = {
              requires = nativePublisherUnits;
              after = nativePublisherUnits;
            };
          };

        services.nginx.virtualHosts."spore-pxe".locations."/_spore-native-boot/" = {
          extraConfig = ''
            internal;
            alias /var/lib/spore-native-boot/;
          '';
        };
      }
    ]
  );
}
