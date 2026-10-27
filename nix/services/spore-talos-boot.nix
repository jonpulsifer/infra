# Talos boot server for folly's bootstrap VLAN. A timer mirrors the signed UKI and the iPXE script
# that boots it, SecureBoot ISO, netboot iPXE and HookOS UKI from the talos-folly/<version> GitHub release, checks each signed
# image against its committed signing cert, and keeps the previous release as prev. Smee
# (./tinkerbell.nix) answers PXE on the VLAN and names the iPXE under dnsmasq's TFTP root; nginx
# serves the UKI, its script, ISO and HookOS.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  lab = import ../lib/lab.nix;
  iface = "bootstrap";
  site = "folly";
  stateDir = "/var/lib/spore-talos-boot";
  siteDir = "${stateDir}/${site}";
  metricsDir = "/var/lib/prometheus-node-exporter-text-files";
  tftpDir = "/var/lib/tftpboot/talos/${site}";
  uki = "metal-amd64-secureboot-uki.efi";
  # iPXE chains this when Smee has no script for the MAC; it boots the UKI with its own command line.
  ukiScript = "metal-amd64-secureboot-uki.ipxe";
  iso = "metal-amd64-secureboot.iso";
  # Signed with the UKI key; Smee's offer names talos/folly/<this> under dnsmasq's TFTP root.
  ipxe = "ipxe-amd64-secureboot.efi";
  # Signed with the HookOS key; iPXE fetches it over HTTP.
  hookos = "hookos-amd64-secureboot-uki.efi";
  signingCert = ../../clusters/folly/talos/secureboot/uki-signing-cert.pem;
  hookosCert = ../../clusters/folly/talos/secureboot/hookos-signing-cert.pem;
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
      ) (lib.splitString "\n" (builtins.readFile ../../clusters/folly/talos/talos.tf));
    in
    if lib.length matches == 1 then
      lib.head matches
    else
      throw "clusters/folly/talos/talos.tf must set talos_version exactly once";
  # Each image build is its own immutable release, tagged talos-<site>/<version>-<run id>.
  releasesApi = "https://api.github.com/repos/jonpulsifer/infra/releases?per_page=100";
  tagPrefix = "talos-${site}/${talosVersion}-";

  bootstrapPrefix = lib.toInt (lib.last (lib.splitString "/" lab.bootstrap.cidr));

  readOnlyLocation = alias: {
    inherit alias;
    extraConfig = ''
      limit_except GET {
        deny all;
      }
      autoindex off;
    '';
  };
in
{
  assertions = [
    {
      assertion = lib.elem "--collector.textfile.directory=${metricsDir}" config.services.prometheus.exporters.node.extraFlags;
      message = "spore-talos-boot writes its metrics to ${metricsDir}, which node-exporter does not read.";
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
        address = lab.bootstrap.spore;
        prefixLength = bootstrapPrefix;
      }
    ];
  };

  networking.firewall.interfaces.${iface} = {
    allowedTCPPorts = [ 80 ];
    allowedUDPPorts = [ 69 ];
    allowedUDPPortRanges = [
      {
        from = 30000;
        to = 30099;
      }
    ];
  };

  services.nginx.virtualHosts."spore-pxe".locations = {
    "= /talos/${site}/${uki}" = readOnlyLocation "${siteDir}/current/${uki}";
    "= /talos/${site}/prev/${uki}" = readOnlyLocation "${siteDir}/prev/${uki}";
    "= /talos/${site}/${ukiScript}" = readOnlyLocation "${siteDir}/current/${ukiScript}";
    "= /talos/${site}/${iso}" = readOnlyLocation "${siteDir}/current/${iso}";
    "= /talos/${site}/${hookos}" = readOnlyLocation "${siteDir}/current/${hookos}";
  };

  systemd.tmpfiles.rules = [
    "d ${stateDir} 0755 root root -"
    "d ${siteDir} 0755 root root -"
    "d /var/lib/tftpboot/talos 0755 root root -"
    "d ${tftpDir} 0755 root root -"
    "L+ ${tftpDir}/${ipxe} - - - - ${siteDir}/current/${ipxe}"
  ];

  systemd.services.spore-talos-boot-mirror = {
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
        local metrics slot version
        metrics=$(mktemp ${metricsDir}/.spore-talos-boot.XXXXXX)
        {
          printf '# HELP spore_talos_boot_mirror_success Whether the last mirror run verified and published the release.\n'
          printf '# TYPE spore_talos_boot_mirror_success gauge\n'
          printf 'spore_talos_boot_mirror_success{site="${site}",wanted_version="${talosVersion}"} %s\n' "$success"
          printf '# HELP spore_talos_boot_mirror_last_success_timestamp_seconds When the mirror last verified the release.\n'
          printf '# TYPE spore_talos_boot_mirror_last_success_timestamp_seconds gauge\n'
          printf 'spore_talos_boot_mirror_last_success_timestamp_seconds{site="${site}"} %s\n' \
            "$(cat "$site_dir/last-success" 2>/dev/null || echo 0)"
          printf '# HELP spore_talos_boot_uki_info The Talos version of each served UKI.\n'
          printf '# TYPE spore_talos_boot_uki_info gauge\n'
          for slot in current prev; do
            version=$(cat "$site_dir/$slot/version" 2>/dev/null || true)
            if [ -n "$version" ]; then
              printf 'spore_talos_boot_uki_info{site="${site}",slot="%s",version="%s"} 1\n' "$slot" "$version"
            fi
          done
        } > "$metrics"
        # node_exporter reads the textfile directory as its own user.
        chmod 0644 "$metrics"
        mv "$metrics" ${metricsDir}/spore-talos-boot.prom
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

      # Each release has a new UKI asset, so an unchanged UKI ETag means an unchanged release.
      etag_args=()
      if [ -s "$site_dir/current/uki.etag" ] && [ -s "$site_dir/current/${iso}" ] \
        && [ -s "$site_dir/current/${ipxe}" ] && [ -s "$site_dir/current/${hookos}" ] \
        && [ -s "$site_dir/current/${ukiScript}" ]; then
        etag_args=(--etag-compare "$site_dir/current/uki.etag")
      fi
      code=$(fetch "''${etag_args[@]}" --etag-save "$stage/uki.etag" \
        --output "$stage/${uki}" --write-out '%{http_code}' "$release_url/${uki}")

      if [ "$code" = 304 ]; then
        echo "current UKI is unchanged"
      else
        ${pkgs.bash}/bin/bash ${verifyUki} ${signingCert} "$stage/${uki}"
        fetch --output "$stage/${ukiScript}" "$release_url/${ukiScript}"
        grep -q '^chain --autofree ${uki} ' "$stage/${ukiScript}"
        fetch --output "$stage/${ipxe}" "$release_url/${ipxe}"
        ${pkgs.bash}/bin/bash ${verifyUki} ${signingCert} "$stage/${ipxe}"
        fetch --output "$stage/${hookos}" "$release_url/${hookos}"
        ${pkgs.bash}/bin/bash ${verifyUki} ${hookosCert} "$stage/${hookos}"
        fetch --output "$stage/${iso}" "$release_url/${iso}"
        test -s "$stage/${iso}"
        printf '%s\n' ${talosVersion} > "$stage/version"

        # A build can change iPXE, HookOS or the script and leave the UKI as it was.
        id=$(cd "$stage" && sha256sum ${uki} ${ukiScript} ${ipxe} ${hookos} | sha256sum | cut -d ' ' -f 1)
        release="$releases/$id"
        if [ -e "$release" ]; then
          install -m 0644 "$stage/uki.etag" "$release/uki.etag"
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
          echo "published ${talosVersion} UKI $id"
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

  systemd.timers.spore-talos-boot-mirror = {
    description = "Periodically mirror the signed Talos boot assets";
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnBootSec = "5m";
      OnUnitActiveSec = "1h";
      RandomizedDelaySec = "5m";
      Unit = "spore-talos-boot-mirror.service";
    };
  };
}
