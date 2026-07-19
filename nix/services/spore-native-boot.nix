# Signed Raspberry Pi native-boot publishing, served as plain static files.
#
# Nix builds each target's boot.img + nix-store.squashfs (see
# nix/hosts/rackpi5.nix). A per-target oneshot copies boot.img into a
# world-traversable release dir, signs boot.sig with the runtime private key,
# and links the squashfs alongside it. nginx then serves that directory
# verbatim at the target's httpPath -- the Pi 5 EEPROM HTTP-boots boot.sig +
# boot.img from there, and the initrd fetches nix-store.squashfs.
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
      "d /var/lib/spore-native-boot 0755 root root -"
    ];

    systemd.services =
      (lib.mapAttrs' (
        id: target:
        lib.nameValuePair "spore-native-boot-${id}" {
          description = "Publish signed native boot target ${id}";
          wantedBy = [ "multi-user.target" ];
          before = [ "nginx.service" ];
          restartTriggers = [ target.package ];
          # rpi-eeprom-digest is a shell script that shells out to openssl and
          # xxd (and greps/awks its output); coreutils covers sha256sum/mktemp.
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

            source_image=${target.package}/boot.img
            source_store=${target.package}/nix-store.squashfs
            signing_key=${lib.escapeShellArg target.signingKey}
            state=/var/lib/spore-native-boot

            test -s "$source_image"
            test -s "$source_store"
            test -s "$signing_key"
            install -d -m 0755 "$state/releases"

            stage=$(mktemp -d "$state/releases/.${id}.XXXXXX")
            trap 'rm -rf "$stage"' EXIT
            # mktemp -d always makes 0700; nginx serves this directory as an
            # unprivileged user, so it must be able to traverse in.
            chmod 0755 "$stage"

            install -m 0644 "$source_image" "$stage/boot.img"
            rpi-eeprom-digest -i "$stage/boot.img" -o "$stage/boot.sig" -k "$signing_key"
            test -s "$stage/boot.sig"
            ln -s "$source_store" "$stage/nix-store.squashfs"

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
          requires = publisherUnits;
          after = publisherUnits;
        };
      };

    # Serve each target's release directory verbatim. The Pi 5 EEPROM fetches
    # boot.sig + boot.img; the initrd fetches nix-store.squashfs (with a
    # ?sha256= query nginx ignores -- the initrd verifies it against the
    # cmdline-pinned digest itself).
    services.nginx.virtualHosts."spore-pxe".locations = lib.mapAttrs' (
      id: target:
      lib.nameValuePair target.httpPath {
        alias = "/var/lib/spore-native-boot/${id}/";
        extraConfig = ''
          limit_except GET {
            deny all;
          }
          autoindex off;
        '';
      }
    ) cfg.nativeBootTargets;
  };
}
