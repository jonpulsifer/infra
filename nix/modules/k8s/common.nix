{
  config,
  lib,
  pkgs,
  ...
}:
let
  networks = import ./networks.nix;
  networkConfig = networks.${config.services.k8s.network};
  cfg = config.services.k8s;
in
{
  config = lib.mkIf cfg.enable {
    # this section is only required for longhorn
    systemd.services.containerd.path = [
      pkgs.openiscsi
      "/run/wrappers/bin"
      "/run/current-system/sw/bin/"
    ];
    systemd.tmpfiles.rules = [
      "L+ /usr/local/bin - - - - /run/current-system/sw/bin/"
    ];

    boot.kernelModules = [
      "br_netfilter"
      "overlay"
      "iptable_raw"
      "xt_socket"
    ];

    networking.firewall.enable = lib.mkForce false;
    systemd.network.config = {
      networkConfig = {
        ManageForeignRoutes = false;
        ManageForeignRoutingPolicyRules = false;
      };
    };

    # cilium writes its own config to /etc/cni/net.d, so we need to make sure it's writable/empty/whatever
    environment.etc."cni/net.d".enable = false;

    environment.systemPackages =
      with pkgs;
      [
        cri-tools
        kubectl
        kubernetes
      ]
      ++ [
        ethtool
        conntrack-tools
        iptables
        socat
      ] # for some k8s networking
      ++ [ openiscsi ]; # for longhorn

    systemd.services.kubelet.preStart = lib.mkForce ''
      ${lib.concatMapStrings (img: ''
        echo "Seeding container image: ${img}"
        ${
          if (lib.hasSuffix "gz" img) then
            ''${pkgs.gzip}/bin/zcat "${img}" | ${pkgs.containerd}/bin/ctr -n k8s.io image import -''
          else
            ''${pkgs.coreutils}/bin/cat "${img}" | ${pkgs.containerd}/bin/ctr -n k8s.io image import -''
        }
      '') config.services.kubernetes.kubelet.seedDockerImages}
    ''; # we do not want to remove /opt/cni/bin/*

    services.prometheus.exporters.node.enable = lib.mkForce false; # we run node-exporter as a daemonset

    nixpkgs.overlays = [ (import ../../overlays/certmgr.nix) ];
    services.certmgr.renewInterval = "21d"; # we want to check and renew certs every 3 weeks instead of every 30m
    
    services.kubernetes = {
      masterAddress = networkConfig.apiServerHostname;
      apiserverAddress = "https://${networkConfig.apiServerHostname}:${toString networkConfig.apiServerPort}";
      apiserver = {
        securePort = networkConfig.apiServerPort;
        advertiseAddress = networkConfig.apiServerIP;
        serviceClusterIpRange = networkConfig.serviceCidr;
      };
      kubelet = {
        enable = true;
        clusterDns = networkConfig.dns;
        cni.packages = lib.mkForce [ ]; # we're using cilium for CNI, so we don't need this
      };
      clusterCidr = networkConfig.podCidr;
      easyCerts = true;
      addons.dns.corefile = ''
        .:10053 {
          errors
          health :10054
          kubernetes cluster.local in-addr.arpa ip6.arpa {
            pods insecure
            fallthrough in-addr.arpa ip6.arpa
          }
          prometheus :10055
          forward . ${networkConfig.upstreamDns}
          cache 30
          loop
          reload
          loadbalance
        }
      '';
    };

    # Add static host entries using the networkConfig directly to avoid circular dependency
    networking.extraHosts = "${networkConfig.apiServerIP} ${networkConfig.apiServerHostname}";
  };
}
