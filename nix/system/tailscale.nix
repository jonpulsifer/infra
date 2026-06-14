{
  config,
  lib,
  pkgs,
  inputs,
  tags,
  ...
}:
let
  tailscaleOffloadScript = pkgs.writeShellScript "tailscale-transport-layer-offloads" ''
    set -u

    interfaces="$(${pkgs.iproute2}/bin/ip -o route show default 2>/dev/null | ${pkgs.gawk}/bin/awk '{print $5}' | ${pkgs.coreutils}/bin/sort -u)"

    if [ -z "$interfaces" ]; then
      for path in /sys/class/net/*; do
        iface="''${path##*/}"
        [ -e "/sys/class/net/$iface/device" ] || continue
        interfaces="$interfaces $iface"
      done
    fi

    for iface in $interfaces; do
      case "$iface" in
        lo|tailscale*|cilium*|lxc*|veth*|docker*|br-*|flannel*|kube*)
          continue
          ;;
      esac

      ${pkgs.ethtool}/bin/ethtool -K "$iface" rx-udp-gro-forwarding on rx-gro-list off || true
    done
  '';
in
{
  environment.systemPackages = with pkgs; [
    tailscale
  ];

  # dnssec = false is required for tailscale to work
  services.resolved = {
    enable = true;
    settings.Resolve.DNSSEC = "false";
  };

  services.tailscale =
    let
      tagsString = lib.concatStringsSep "," (lib.map (tag: "tag:${tag}") tags);
    in
    {
      enable = true;
      authKeyFile = "/var/secrets/tailscale-auth-key";
      extraUpFlags = [ "--advertise-tags=${tagsString}" ];
      extraSetFlags = [ "--accept-routes=true" ];
    };

  systemd.services.tailscale-transport-layer-offloads = {
    # https://tailscale.com/kb/1320/performance-best-practices#ethtool-configuration
    enable = config.services.tailscale.enable;
    description = "Linux optimizations for subnet routers and exit nodes";
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
    wantedBy = [ "multi-user.target" ];
    serviceConfig = {
      Type = "oneshot";
      ExecStart = tailscaleOffloadScript;
    };
  };
}
