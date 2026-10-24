# The lab's SPIRE server. Agents on Talos nodes attest by their TPM's EK public key hash, and every
# registration entry is declared here and synced by a oneshot, so git holds the whole entry list.
# docs/platform/identity.md has the design.
{
  config,
  lib,
  pkgs,
  inputs,
  ...
}:
let
  cfg = config.homelab.spire;
  folly = (import ../lib/networks.nix).folly;
  spire = pkgs.callPackage ../lib/spire.nix {
    inherit (inputs.unstable.legacyPackages.${pkgs.stdenv.hostPlatform.system}) go_1_27;
  };
  spireServer = lib.getExe' spire.package "spire-server";
  socket = config.services.spire.server.settings.server.socket_path;
  hashPath = "/etc/spire/tpm-hashes";
  metricsDir = "/var/lib/prometheus-node-exporter-text-files";
  serverID = "spiffe://${cfg.trustDomain}/spire/server";

  # The notifier's folly credential. The kubeconfig holds no secret: it names the token that
  # systemd hands the DynamicUser server as a credential.
  bundleWriterToken = "spire/folly-bundle-writer-token";
  tokenCredential = "folly-bundle-writer-token";
  follyKubeconfig = pkgs.writeText "spire-folly-kubeconfig.json" (
    builtins.toJSON {
      apiVersion = "v1";
      kind = "Config";
      clusters = [
        {
          name = "folly";
          cluster = {
            server = folly.apiServer;
            certificate-authority = "${folly.apiServerCA}";
          };
        }
      ];
      users = [
        {
          name = "spire-bundle-writer";
          user.tokenFile = "/run/credentials/spire-server.service/${tokenCredential}";
        }
      ];
      contexts = [
        {
          name = "folly";
          context = {
            cluster = "folly";
            user = "spire-bundle-writer";
          };
        }
      ];
      current-context = "folly";
    }
  );

  # Folly's pods reach spore unmasqueraded: spore is inside Cilium's native-routing CIDR.
  agentSources = [
    folly.nodeCidr
    folly.podCidr
  ];

  ekHashes = pkgs.runCommand "spire-tpm-ek-hashes" { } ''
    mkdir $out
    ${lib.concatMapStrings (hash: "touch $out/${hash}\n") cfg.ekHashes}
  '';

  parentOf = entry: if entry.parentID == null then serverID else entry.parentID;
  # Stable across selector edits, so a changed entry updates in place. The prefix marks the
  # entries this sync owns and may prune.
  entryID =
    entry:
    "git-"
    + builtins.substring 0 16 (builtins.hashString "sha256" "${parentOf entry} ${entry.spiffeID}");
  entryArgs =
    entry:
    lib.escapeShellArgs (
      [
        (entryID entry)
        "-spiffeID"
        entry.spiffeID
        "-parentID"
        (parentOf entry)
      ]
      ++ lib.concatMap (selector: [
        "-selector"
        selector
      ]) entry.selectors
    );
in
{
  options.homelab.spire = {
    enable = lib.mkEnableOption "the lab's SPIRE server";
    trustDomain = lib.mkOption {
      type = lib.types.str;
      default = "lolwtf.ca";
      description = "The SPIFFE trust domain the server issues identities in.";
    };
    jwtIssuer = lib.mkOption {
      type = lib.types.str;
      default = "https://spire.lolwtf.ca";
      description = "The iss claim of every JWT-SVID. It equals the OIDC discovery provider's public URL, which GCP checks.";
    };
    port = lib.mkOption {
      type = lib.types.port;
      default = 8081;
      description = "The TCP port agents reach the server on.";
    };
    metricsPort = lib.mkOption {
      type = lib.types.port;
      default = 9988;
      description = "The Prometheus exporter's TCP port.";
    };
    bundleNotifier.enable = lib.mkEnableOption ''
      the k8sbundle notifier, which writes the bundle into folly's spire/spire-bundle ConfigMap on
      every rotation. It needs `${bundleWriterToken}` in the host's sops file, and the server
      fails to start while folly's API server refuses it
    '';
    ekHashes = lib.mkOption {
      type = lib.types.listOf (lib.types.strMatching "[0-9a-f]{64}");
      default = [ ];
      description = "SHA-256 hashes of the TPM EK public keys allowed to attest, lowercase hex.";
    };
    entries = lib.mkOption {
      default = [ ];
      description = "The registration entries. The sync creates, updates and prunes to match this list.";
      type = lib.types.listOf (
        lib.types.submodule {
          options = {
            spiffeID = lib.mkOption {
              type = lib.types.str;
              description = "The SPIFFE ID the entry issues.";
            };
            parentID = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = "The parent's SPIFFE ID. Null makes a node entry: an alias for every agent whose node selectors match.";
            };
            selectors = lib.mkOption {
              type = lib.types.nonEmptyListOf lib.types.str;
              description = "The type:value selectors a node or workload must match.";
            };
          };
        }
      );
    };
  };

  config = lib.mkIf cfg.enable {
    services.spire.server = {
      enable = true;
      inherit (spire) package;
      settings = {
        server = {
          trust_domain = cfg.trustDomain;
          jwt_issuer = cfg.jwtIssuer;
          bind_address = "0.0.0.0";
          bind_port = cfg.port;
          ca_ttl = "24h";
        };
        plugins = {
          DataStore.sql.plugin_data = {
            database_type = "sqlite3";
            connection_string = "$STATE_DIRECTORY/datastore.sqlite3";
          };
          KeyManager.disk.plugin_data.keys_path = "$STATE_DIRECTORY/keys.json";
          NodeAttestor.tpm = {
            plugin_cmd = lib.getExe spire.tpmPlugin;
            plugin_data.hash_path = hashPath;
          };
          Notifier = lib.mkIf cfg.bundleNotifier.enable {
            k8sbundle.plugin_data = {
              namespace = "spire";
              config_map = "spire-bundle";
              config_map_key = "bundle.crt";
              kube_config_file_path = "${follyKubeconfig}";
            };
          };
        };
        telemetry.Prometheus = {
          host = "0.0.0.0";
          port = cfg.metricsPort;
        };
      };
    };

    environment.etc."spire/tpm-hashes".source = ekHashes;

    systemd.services.spire-server = lib.mkMerge [
      { serviceConfig.StateDirectory = lib.mkForce "spire"; }
      # The server exits when the notifier cannot write the bundle at startup, so it retries
      # every 30s until folly's API server answers instead of hitting the start limit.
      (lib.mkIf cfg.bundleNotifier.enable {
        startLimitIntervalSec = 0;
        serviceConfig = {
          LoadCredential = "${tokenCredential}:${config.sops.secrets.${bundleWriterToken}.path}";
          RestartSec = "30s";
        };
      })
    ];

    sops.secrets = lib.mkIf cfg.bundleNotifier.enable {
      ${bundleWriterToken}.restartUnits = [ "spire-server.service" ];
    };

    systemd.services.spire-server-entries = {
      description = "Sync the SPIRE registration entries declared in git";
      wantedBy = [ "multi-user.target" ];
      requires = [ "spire-server.service" ];
      after = [ "spire-server.service" ];
      partOf = [ "spire-server.service" ];
      path = [
        pkgs.coreutils
        pkgs.gnugrep
        pkgs.jq
      ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
      };
      script = ''
        set -euo pipefail

        srv() { ${spireServer} "$@" -socketPath ${socket}; }

        for _ in $(seq 60); do
          srv healthcheck >/dev/null 2>&1 && break
          sleep 1
        done
        srv healthcheck

        existing=$(srv entry show -output json | jq -r '.entries[]?.id')
        declared=()
        apply() {
          local id=$1
          shift
          declared+=("$id")
          if grep -qxF "$id" <<<"$existing"; then
            srv entry update -entryID "$id" "$@"
          else
            srv entry create -entryID "$id" "$@"
          fi
        }

        ${lib.concatMapStrings (entry: "apply ${entryArgs entry}\n") cfg.entries}

        for id in $(grep '^git-' <<<"$existing" || true); do
          if ! printf '%s\n' "''${declared[@]}" | grep -qxF "$id"; then
            srv entry delete -entryID "$id"
          fi
        done
      '';
    };

    # SPIRE exports no gauge of attested agents, so this one counts the agents whose SVID is
    # unexpired and that are not banned, into the node exporter's textfile directory.
    systemd.services.spire-server-agent-count = {
      description = "Export the SPIRE server's live agent count";
      requires = [ "spire-server.service" ];
      after = [ "spire-server.service" ];
      path = [
        pkgs.coreutils
        pkgs.jq
      ];
      serviceConfig.Type = "oneshot";
      script = ''
        set -euo pipefail
        count=$(${spireServer} agent list -socketPath ${socket} -output json |
          jq '[.agents[]? | select((.banned | not) and (.x509svid_expires_at | tonumber) > now)] | length')
        metrics=$(mktemp ${metricsDir}/.spire-server.XXXXXX)
        trap 'rm -f "$metrics"' EXIT
        {
          printf '# HELP spire_server_attested_agents Agents with an unexpired, unbanned SVID.\n'
          printf '# TYPE spire_server_attested_agents gauge\n'
          printf 'spire_server_attested_agents %s\n' "$count"
        } > "$metrics"
        chmod 0644 "$metrics"
        mv "$metrics" ${metricsDir}/spire-server.prom
        trap - EXIT
      '';
    };

    systemd.timers.spire-server-agent-count = {
      description = "Periodically export the SPIRE server's live agent count";
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "2m";
        OnUnitActiveSec = "1m";
      };
    };

    assertions = [
      {
        assertion = lib.elem "--collector.textfile.directory=${metricsDir}" config.services.prometheus.exporters.node.extraFlags;
        message = "spire-server.nix writes its agent gauge to ${metricsDir}; the node exporter's textfile collector must read it";
      }
    ];

    # Only folly's nodes and pods reach the agent API and the exporter.
    networking.firewall.extraCommands = lib.concatMapStrings (cidr: ''
      iptables -A nixos-fw -p tcp -s ${cidr} -m multiport --dports ${toString cfg.port},${toString cfg.metricsPort} -j nixos-fw-accept
    '') agentSources;
  };
}
