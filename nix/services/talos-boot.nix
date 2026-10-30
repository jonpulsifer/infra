# Talos boot server for folly's bootstrap VLAN, on spore. A timer mirrors the SecureBoot ISO,
# netboot iPXE and HookOS UKI from the talos-folly/<version> GitHub release, checks each signed image
# against its committed signing cert, and keeps the previous release as prev. dnsmasq serves the
# iPXE over TFTP and nginx serves the rest at spore's bootstrap address, which the Kubernetes
# network's DHCP names (terraform/network/unifi/folly/k8s.tf). Smee (./tinkerbell.nix) answers PXE
# on the VLAN, and fleetd (./fleetd.nix) serves the enrollment name's HTTPS at the same address.
{
  config,
  lib,
  pkgs,
  name,
  ...
}:
let
  lab = import ../lib/anchor.nix;
  fleet = import ../lib/fleet.nix;
  # fleetd's boot listener answers this name (./fleetd.nix).
  host = "enroll.${fleet.dnsZone}";
  iface = "bootstrap";
  site = config.homelab.site;
  address = lab.bootstrap.hosts.spore;
  stateDir = "/var/lib/talos-boot";
  siteDir = "${stateDir}/${site}";
  metricsDir = "/var/lib/prometheus-node-exporter-text-files";
  tftpDir = "/var/lib/tftpboot/talos/${site}";
  iso = "metal-amd64-secureboot.iso";
  # Signed with the UKI key; the bootstrap network's DHCP names talos/folly/<this> under dnsmasq's
  # TFTP root.
  ipxe = "ipxe-amd64-secureboot.efi";
  # Signed with the HookOS key; iPXE fetches it over HTTP, from Smee's script or its own menu.
  hookos = "hookos-amd64-secureboot-uki.efi";
  signingCert = ../../clusters/${site}/talos/secureboot/uki-signing-cert.pem;
  hookosCert = ../../clusters/${site}/talos/secureboot/hookos-signing-cert.pem;
  # The pipeline's check: exactly one signature, and sbverify against the committed certificate.
  verifyUki = ../../.github/scripts/talos-uki-verify.sh;

  # The release tag follows the Talos version the folly root installs.
  talosVersion =
    let
      matches = lib.concatMap (
        line:
        let
          m = builtins.match ''[[:space:]]*talos_version[[:space:]]*=[[:space:]]*"(v[0-9]+\.[0-9]+\.[0-9]+)".*'' line;
        in
        if m == null then [ ] else m
      ) (lib.splitString "\n" (builtins.readFile ../../clusters/${site}/talos/talos.tf));
    in
    if lib.length matches == 1 then
      lib.head matches
    else
      throw "clusters/${site}/talos/talos.tf must set talos_version exactly once";
  # Each image build is its own immutable release, tagged talos-<site>/<version>-<run id>.
  releasesApi = "https://api.github.com/repos/jonpulsifer/infra/releases?per_page=100";
  tagPrefix = "talos-${site}/${talosVersion}-";

  bootstrapPrefix = lib.toInt (lib.last (lib.splitString "/" lab.bootstrap.cidr));
  # The gateway's address on the VLAN, the CIDR's first host, as UniFi takes it
  # (terraform/network/unifi/folly/bootstrap.tf).
  bootstrapGateway =
    let
      octets = lib.splitString "." (lib.head (lib.splitString "/" lab.bootstrap.cidr));
    in
    lib.concatStringsSep "." (lib.init octets ++ [ (toString (lib.toInt (lib.last octets) + 1)) ]);
  # The routing table for traffic from the bootstrap addresses, named for the VLAN.
  bootstrapTable = lab.bootstrap.vlan;

  readOnlyLocation = alias: {
    inherit alias;
    extraConfig = ''
      limit_except GET {
        deny all;
      }
      autoindex off;
    '';
  };

  # The bootstrap VLAN holds unenrolled machines, so its interface admits only what they use: the
  # ports declared for it (here and in ./tinkerbell.nix), DNS, NTP and ping. The global allowed ports apply on every
  # interface, so the chain runs before them, after nixos-fw's trusted-interface and
  # established-connection accepts. NixOS deletes and recreates nixos-fw-accept and
  # nixos-fw-log-refuse on every reload, which fails while another chain refers to them, so this
  # chain ends in the built-in ACCEPT and DROP.
  bootstrapChain = "nixos-fw-bootstrap";
  bootstrapPosition = lib.length config.networking.firewall.trustedInterfaces + 2;
  bootstrapRules =
    let
      allowed = config.networking.firewall.interfaces.${iface};
      dports =
        proto: ports: ranges:
        map (port: "-p ${proto} --dport ${toString port}") (lib.unique ports)
        ++ map (range: "-p ${proto} --dport ${toString range.from}:${toString range.to}") ranges;
    in
    dports "tcp" (allowed.allowedTCPPorts ++ [ 53 ]) allowed.allowedTCPPortRanges
    ++ dports "udp" (
      allowed.allowedUDPPorts
      ++ [
        53
        123
      ]
    ) allowed.allowedUDPPortRanges
    ++ [ "-p icmp --icmp-type echo-request" ];

  # The probe below: dnsmasq runs, and nginx serves HookOS at spore's bootstrap address.
  serves = pkgs.writeShellScript "talos-boot-serves" ''
    ${pkgs.systemd}/bin/systemctl is-active --quiet dnsmasq.service
    ${pkgs.curl}/bin/curl --fail --silent --head --output /dev/null --max-time 2 http://${address}/talos/${site}/${hookos}
  '';
  # The second probe: fleetd serves the enrollment name with a certificate that Talos's bundled
  # roots trust.
  servesHttps = pkgs.writeShellScript "talos-boot-serves-https" ''
    ${pkgs.curl}/bin/curl --fail --silent --output /dev/null --max-time 2 \
      --cacert ${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt \
      --resolve ${host}:443:${address} https://${host}/healthz
  '';
in
{
  assertions = [
    {
      assertion = lab.bootstrap.hosts ? ${name};
      message = "talos-boot.nix may only be imported by a host with a bootstrap address: ${lib.concatStringsSep ", " (lib.attrNames lab.bootstrap.hosts)}";
    }
  ];

  networking.vlans.${iface} = {
    id = lab.bootstrap.vlan;
    interface = "end0";
  };
  networking.interfaces.${iface} = {
    useDHCP = false;
    ipv4.addresses = [
      {
        inherit address;
        prefixLength = bootstrapPrefix;
      }
    ];
  };

  # A node on the Kubernetes network reaches the boot services through the gateway, which routes it
  # onto the VLAN (the UniFi policies kubernetes_to_boot). The main table sends its replies out
  # end0, and the firewall's strict reverse-path filter drops the request, so traffic from the
  # bootstrap address takes a table whose default is the gateway on the VLAN. The filter's reverse lookup takes the request's destination as its source, matches the
  # rule, and finds the route back out the interface the request arrived on.
  systemd.network.networks."40-${iface}" = {
    routes = [
      {
        Destination = lab.bootstrap.cidr;
        Scope = "link";
        PreferredSource = address;
        Table = bootstrapTable;
      }
      {
        Gateway = bootstrapGateway;
        Table = bootstrapTable;
      }
    ];
    routingPolicyRules = [
      {
        From = lab.bootstrap.cidr;
        Table = bootstrapTable;
        Priority = 1000;
      }
    ];
  };

  # 80 for nginx's boot files, 443 for fleetd's enrollment name.
  networking.firewall.interfaces.${iface} = {
    allowedTCPPorts = [
      80
      443
    ];
    allowedUDPPorts = [ 69 ];
  };

  # IPv6 on the VLAN is link-local only, so it gets neighbour discovery and nothing else.
  networking.firewall.extraCommands = ''
    iptables -w -N ${bootstrapChain} 2>/dev/null || true
    iptables -w -F ${bootstrapChain}
    ${lib.concatMapStrings (rule: ''
      iptables -w -A ${bootstrapChain} ${rule} -j ACCEPT
    '') bootstrapRules}
    iptables -w -A ${bootstrapChain} -j DROP
    iptables -w -I nixos-fw ${toString bootstrapPosition} -i ${iface} -j ${bootstrapChain}

    ip6tables -w -N ${bootstrapChain} 2>/dev/null || true
    ip6tables -w -F ${bootstrapChain}
    ip6tables -w -A ${bootstrapChain} -p icmpv6 --icmpv6-type redirect -j DROP
    ip6tables -w -A ${bootstrapChain} -p icmpv6 --icmpv6-type 139 -j DROP
    ip6tables -w -A ${bootstrapChain} -p icmpv6 -j ACCEPT
    ip6tables -w -A ${bootstrapChain} -j DROP
    ip6tables -w -I nixos-fw ${toString bootstrapPosition} -i ${iface} -j ${bootstrapChain}
  '';

  # TFTP only (port=0): no DHCP and no DNS.
  services.dnsmasq = {
    enable = true;
    resolveLocalQueries = false;
    settings = {
      port = 0;
      enable-tftp = true;
      tftp-root = "/var/lib/tftpboot";
      tftp-max = 100;
      # TFTP data leaves UDP/69 too, so a transfer is one flow. The gateway's reply rule for the
      # Kubernetes network (kubernetes_to_boot) matches only the request's port, and this chain
      # admits only port 69.
      tftp-single-port = true;
    };
  };

  services.nginx = {
    enable = true;
    virtualHosts.talos-boot = {
      listen = [
        {
          addr = address;
          port = 80;
        }
      ];
      locations = {
        "/".return = "404";
        "= /talos/${site}/${iso}" = readOnlyLocation "${siteDir}/current/${iso}";
        "= /talos/${site}/${hookos}" = readOnlyLocation "${siteDir}/current/${hookos}";
      };
    };
  };

  systemd.tmpfiles.rules = [
    "d ${stateDir} 0755 root root -"
    "d ${siteDir} 0755 root root -"
    "d /var/lib/tftpboot 0755 root root -"
    "d /var/lib/tftpboot/talos 0755 root root -"
    "d ${tftpDir} 0755 root root -"
    "L+ ${tftpDir}/${ipxe} - - - - ${siteDir}/current/${ipxe}"
  ];

  # Whether spore passes each check. The cluster cannot reach the bootstrap VLAN, so node-exporter
  # carries them.
  systemd.services.talos-boot-check = {
    description = "Export whether spore serves the Talos boot files and the enrollment name";
    path = with pkgs; [ coreutils ];
    serviceConfig = {
      Type = "oneshot";
      UMask = "0022";
      NoNewPrivileges = true;
      PrivateDevices = true;
      PrivateTmp = true;
      ProtectHome = true;
      ProtectSystem = "strict";
      ReadWritePaths = [ metricsDir ];
    };
    script = ''
      set -u
      serving=0
      if ${serves}; then
        serving=1
      fi
      https=0
      if ${servesHttps}; then
        https=1
      fi
      metrics=$(mktemp ${metricsDir}/.talos-boot-check.XXXXXX)
      trap 'rm -f "$metrics"' EXIT
      {
        printf '# HELP talos_boot_serving Whether dnsmasq runs and nginx serves HookOS at spore.\n'
        printf '# TYPE talos_boot_serving gauge\n'
        printf 'talos_boot_serving{site="${site}"} %s\n' "$serving"
        printf '# HELP talos_boot_https_serving Whether fleetd serves the enrollment name at spore with a certificate Talos trusts.\n'
        printf '# TYPE talos_boot_https_serving gauge\n'
        printf 'talos_boot_https_serving{site="${site}"} %s\n' "$https"
      } > "$metrics"
      # node_exporter reads the textfile directory as its own user.
      chmod 0644 "$metrics"
      mv "$metrics" ${metricsDir}/talos-boot-check.prom
      trap - EXIT
    '';
  };

  systemd.timers.talos-boot-check = {
    description = "Periodically export the Talos boot file and enrollment name state";
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnBootSec = "2m";
      OnUnitActiveSec = "1m";
      Unit = "talos-boot-check.service";
    };
  };

  systemd.services.talos-boot-mirror = {
    description = "Mirror the signed Talos boot assets for ${site}";
    wants = [ "network-online.target" ];
    after = [ "network-online.target" ];
    path = with pkgs; [
      coreutils
      curl
      findutils
      jq
      openssl
      sbsigntool
    ];
    serviceConfig = {
      Type = "oneshot";
      TimeoutStartSec = "1h";
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
      ReadWritePaths = [
        stateDir
        metricsDir
      ];
      RestrictAddressFamilies = [
        "AF_UNIX"
        "AF_INET"
        "AF_INET6"
      ];
      RestrictNamespaces = true;
      RestrictRealtime = true;
      LockPersonality = true;
      MemoryDenyWriteExecute = true;
      CapabilityBoundingSet = "";
      SystemCallArchitectures = "native";
    };
    script = ''
      set -euo pipefail

      site_dir=${siteDir}
      releases="$site_dir/releases"
      success=0
      stage=""

      write_metrics() {
        local metrics slot version release
        metrics=$(mktemp ${metricsDir}/.talos-boot-mirror.XXXXXX)
        {
          printf '# HELP talos_boot_mirror_success Whether the last mirror run verified and published the release.\n'
          printf '# TYPE talos_boot_mirror_success gauge\n'
          printf 'talos_boot_mirror_success{site="${site}",wanted_version="${talosVersion}"} %s\n' "$success"
          printf '# HELP talos_boot_mirror_last_success_timestamp_seconds When the mirror last verified the release.\n'
          printf '# TYPE talos_boot_mirror_last_success_timestamp_seconds gauge\n'
          printf 'talos_boot_mirror_last_success_timestamp_seconds{site="${site}"} %s\n' \
            "$(cat "$site_dir/last-success" 2>/dev/null || echo 0)"
          printf '# HELP talos_boot_uki_info The Talos version and release (the digest of its boot files) of each served slot.\n'
          printf '# TYPE talos_boot_uki_info gauge\n'
          for slot in current prev; do
            version=$(cat "$site_dir/$slot/version" 2>/dev/null || true)
            release=$(basename "$(readlink "$site_dir/$slot" || true)")
            if [ -n "$version" ]; then
              printf 'talos_boot_uki_info{site="${site}",slot="%s",version="%s",release="%s"} 1\n' "$slot" "$version" "$release"
            fi
          done
        } > "$metrics"
        # node_exporter reads the textfile directory as its own user.
        chmod 0644 "$metrics"
        mv "$metrics" ${metricsDir}/talos-boot-mirror.prom
      }

      cleanup() {
        if [ -n "$stage" ]; then
          rm -rf "$stage"
        fi
        write_metrics
      }
      trap cleanup EXIT

      fetch() {
        curl --fail --location --silent --show-error --retry 3 --max-time 1800 "$@"
      }

      install -d -m 0755 "$releases"
      find "$releases" -mindepth 1 -maxdepth 1 -name '.stage.*' -exec rm -rf {} +
      stage=$(mktemp -d "$releases/.stage.XXXXXX")
      # mktemp -d makes 0700; nginx reads the release as an unprivileged user.
      chmod 0755 "$stage"

      # The newest published release of this Talos version. The tag holds a
      # slash, which the download URL carries encoded.
      tag=$(fetch --header 'Accept: application/vnd.github+json' "${releasesApi}" \
        | jq -r --arg prefix "${tagPrefix}" \
          '[.[] | select(.draft | not) | select(.tag_name | startswith($prefix))] | sort_by(.created_at) | last | .tag_name // empty')
      if [ -z "$tag" ]; then
        echo "no published release is tagged ${tagPrefix}*" >&2
        exit 1
      fi
      release_url="https://github.com/jonpulsifer/infra/releases/download/''${tag//\//%2F}"

      if [ "$(cat "$site_dir/current/tag" 2>/dev/null || true)" = "$tag" ] && [ -s "$site_dir/current/${iso}" ] \
        && [ -s "$site_dir/current/${ipxe}" ] && [ -s "$site_dir/current/${hookos}" ]; then
        echo "current release $tag is unchanged"
      else
        fetch --output "$stage/${ipxe}" "$release_url/${ipxe}"
        ${pkgs.bash}/bin/bash ${verifyUki} ${signingCert} "$stage/${ipxe}"
        fetch --output "$stage/${hookos}" "$release_url/${hookos}"
        ${pkgs.bash}/bin/bash ${verifyUki} ${hookosCert} "$stage/${hookos}"
        fetch --output "$stage/${iso}" "$release_url/${iso}"
        test -s "$stage/${iso}"
        printf '%s\n' ${talosVersion} > "$stage/version"
        printf '%s\n' "$tag" > "$stage/tag"

        # Two builds of the same inputs can publish the same files.
        id=$(cd "$stage" && sha256sum ${iso} ${ipxe} ${hookos} | sha256sum | cut -d ' ' -f 1)
        release="$releases/$id"
        if [ -e "$release" ]; then
          install -m 0644 "$stage/tag" "$release/tag"
        else
          mv "$stage" "$release"
          stage=""
        fi

        old=$(readlink "$site_dir/current" || true)
        if [ "$old" != "releases/$id" ]; then
          if [ -n "$old" ]; then
            ln -sfn "$old" "$site_dir/.prev.new"
            mv -Tf "$site_dir/.prev.new" "$site_dir/prev"
          fi
          ln -sfn "releases/$id" "$site_dir/.current.new"
          mv -Tf "$site_dir/.current.new" "$site_dir/current"
          echo "published ${talosVersion} release $id"
        fi

        keep_current=$(readlink "$site_dir/current" || true)
        keep_prev=$(readlink "$site_dir/prev" || true)
        for dir in "$releases"/*; do
          [ -d "$dir" ] || continue
          rel="releases/$(basename "$dir")"
          if [ "$rel" != "$keep_current" ] && [ "$rel" != "$keep_prev" ]; then
            rm -rf "$dir"
          fi
        done
      fi

      date +%s > "$site_dir/last-success"
      success=1
    '';
  };

  systemd.timers.talos-boot-mirror = {
    description = "Periodically mirror the signed Talos boot assets";
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnBootSec = "5m";
      OnUnitActiveSec = "1h";
      RandomizedDelaySec = "5m";
      Unit = "talos-boot-mirror.service";
    };
  };
}
