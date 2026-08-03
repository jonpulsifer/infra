# Signed Raspberry Pi native-boot publishing, served as plain static files.
#
# Nix builds each target's boot.img + nix-store.squashfs (see
# nix/hosts/rackpi5.nix). A per-target oneshot signs and atomically publishes
# the current boot.img/boot.sig pair while retaining every squashfs under its
# content digest. The Pi 5 EEPROM fetches the stable boot paths, and the signed
# initrd fetches the digest-addressed squashfs pinned in its command line.
#
# There is no application, database, or dynamic boot decision: the image is the
# policy, and the EEPROM/initrd verify integrity (secure-boot signature +
# cmdline-pinned squashfs sha256) themselves. The static x86 iPXE tree stays in
# nix/services/pxe-netboot.nix; this module only adds the native-boot targets.
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
  stateDir = "/var/lib/spore-native-boot";
  metricsDir = "/var/lib/prometheus-node-exporter-text-files";

  targetType = types.submodule {
    options = {
      package = mkOption {
        type = types.package;
        description = "Derivation exposing boot.img and nix-store.squashfs for this target.";
      };
      signingKey = mkOption {
        type = types.str;
        description = "Runtime path to the private key used to sign boot.img.";
      };
      httpPath = mkOption {
        type = types.strMatching "^/[A-Za-z0-9._~/-]+/$";
        description = "nginx location prefix the artifacts are served under (trailing slash required).";
      };
    };
  };

  publisherUnits = map (id: "spore-native-boot-${id}.service") (
    builtins.attrNames cfg.nativeBootTargets
  );

  readOnlyLocation = alias: {
    inherit alias;
    extraConfig = ''
      limit_except GET {
        deny all;
      }
      autoindex off;
    '';
  };

  targetLocations = lib.listToAttrs (
    lib.concatLists (
      lib.mapAttrsToList (id: target: [
        {
          name = "= ${target.httpPath}boot.img";
          value = readOnlyLocation "${stateDir}/${id}/boot.img";
        }
        {
          name = "= ${target.httpPath}boot.sig";
          value = readOnlyLocation "${stateDir}/${id}/boot.sig";
        }
        # Compatibility for a signed image fetched before this module moved to
        # digest-addressed squashfs URLs.
        {
          name = "= ${target.httpPath}nix-store.squashfs";
          value = readOnlyLocation "${stateDir}/${id}/nix-store.squashfs";
        }
        {
          name = target.httpPath;
          value = readOnlyLocation "${stateDir}/stores/${id}/";
        }
      ]) cfg.nativeBootTargets
    )
  );

  artifactChecks = lib.concatStringsSep "\n" (
    lib.mapAttrsToList (id: target: ''
      target_id=${lib.escapeShellArg id}
      base_url=${lib.escapeShellArg ("http://127.0.0.1" + target.httpPath)}
      digest=$(cat ${lib.escapeShellArg "${stateDir}/${id}/squashfs.sha256"} 2>/dev/null || true)

      check_artifact "$target_id" boot_img "$base_url/boot.img"
      check_artifact "$target_id" boot_sig "$base_url/boot.sig"
      if [[ "$digest" =~ ^[0-9a-f]{64}$ ]]; then
        check_artifact "$target_id" squashfs "$base_url/$digest.squashfs"
      else
        printf 'spore_native_boot_artifact_available{target="%s",artifact="squashfs"} 0\n' \
          "$target_id" >> "$metrics"
      fi
    '') cfg.nativeBootTargets
  );
in
{
  options.services.spore = {
    enable = mkEnableOption "signed Raspberry Pi native-boot artifact publishing";
    nativeBootTargets = mkOption {
      type = types.attrsOf targetType;
      default = { };
      description = "Signed native boot targets published and served over static HTTP.";
    };
  };

  config = mkIf cfg.enable {
    systemd.tmpfiles.rules = [
      "d ${stateDir} 0755 root root -"
      "d ${metricsDir} 0755 root root -"
    ];

    systemd.services =
      (lib.mapAttrs' (
        id: target:
        lib.nameValuePair "spore-native-boot-${id}" {
          description = "Publish signed native boot target ${id}";
          wantedBy = [ "multi-user.target" ];
          before = [ "nginx.service" ];
          restartTriggers = [ target.package ];
          # rpi-eeprom-digest shells out to openssl and xxd (and greps/awks its
          # output); coreutils covers sha256sum/mktemp/install/mv.
          path = with pkgs; [
            coreutils
            gawk
            gnugrep
            openssl
            raspberrypi-eeprom
            xxd
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
            ReadWritePaths = [ stateDir ];
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

            source_image=${target.package}/boot.img
            source_store=${target.package}/nix-store.squashfs
            signing_key=${lib.escapeShellArg target.signingKey}
            state=${stateDir}

            test -s "$source_image"
            test -s "$source_store"
            test -s "$signing_key"
            install -d -m 0755 "$state/releases" "$state/stores/${id}"

            squashfs_sha256=$(sha256sum "$source_store" | cut -d ' ' -f 1)
            store_link="$state/stores/${id}/$squashfs_sha256.squashfs"
            ln -sfn "$source_store" "$state/stores/${id}/.$squashfs_sha256.new"
            mv -Tf "$state/stores/${id}/.$squashfs_sha256.new" "$store_link"

            stage=$(mktemp -d "$state/releases/.${id}.XXXXXX")
            trap 'rm -rf "$stage"' EXIT
            # mktemp -d always makes 0700; nginx serves this directory as an
            # unprivileged user, so it must be able to traverse in.
            chmod 0755 "$stage"

            install -m 0644 "$source_image" "$stage/boot.img"
            rpi-eeprom-digest -i "$stage/boot.img" -o "$stage/boot.sig" -k "$signing_key"
            test -s "$stage/boot.sig"
            ln -s "$source_store" "$stage/nix-store.squashfs"
            printf '%s\n' "$squashfs_sha256" > "$stage/squashfs.sha256"

            # Content-addressed release id keeps publishes idempotent and the
            # symlink swap atomic.
            release_id=$(sha256sum "$stage/boot.img" "$stage/boot.sig" | sha256sum | cut -d ' ' -f 1)
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
      ) cfg.nativeBootTargets)
      // {
        nginx = {
          # A failed publisher costs native-boot recovery, but it must not keep
          # the independent x86 PXE HTTP tree offline.
          wants = publisherUnits;
          after = publisherUnits;
        };

        spore-native-boot-artifact-check = {
          description = "Probe published native-boot artifacts over HTTP";
          after = [ "nginx.service" ] ++ publisherUnits;
          wants = [ "nginx.service" ] ++ publisherUnits;
          path = with pkgs; [
            coreutils
            curl
          ];
          serviceConfig = {
            Type = "oneshot";
            UMask = "0022";
            NoNewPrivileges = true;
            PrivateDevices = true;
            PrivateTmp = true;
            ProtectSystem = "strict";
            ReadWritePaths = [ metricsDir ];
          };
          script = ''
            set -u
            metrics=$(mktemp ${metricsDir}/.spore-native-boot.XXXXXX)
            trap 'rm -f "$metrics"' EXIT
            printf '# HELP spore_native_boot_artifact_available Whether a published native-boot artifact returns HTTP 200.\n' > "$metrics"
            printf '# TYPE spore_native_boot_artifact_available gauge\n' >> "$metrics"

            check_artifact() {
              local target="$1" artifact="$2" url="$3" available=0 code
              code=$(curl --silent --max-time 10 --header 'Host: spore-pxe' \
                --output /dev/null --write-out '%{http_code}' "$url" || true)
              if [ "$code" = 200 ]; then
                available=1
              fi
              printf 'spore_native_boot_artifact_available{target="%s",artifact="%s"} %s\n' \
                "$target" "$artifact" "$available" >> "$metrics"
            }

            ${artifactChecks}
            mv "$metrics" ${metricsDir}/spore-native-boot.prom
            trap - EXIT
          '';
        };
      };

    systemd.timers.spore-native-boot-artifact-check = {
      description = "Periodically probe native-boot artifacts";
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "2m";
        OnUnitActiveSec = "1m";
        Unit = "spore-native-boot-artifact-check.service";
      };
    };

    services.prometheus.exporters.node = {
      enabledCollectors = [ "textfile" ];
      extraFlags = [ "--collector.textfile.directory=${metricsDir}" ];
    };

    services.nginx.virtualHosts."spore-pxe".locations = targetLocations;
  };
}
