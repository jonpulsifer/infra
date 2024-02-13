{ config, lib, pkgs, ... }:
let
  kubeAPIServerIP = "10.3.0.10";
  kubeAPIServerHostname = "k8s.lolwtf.ca";
  kubeAPIServerPort = 6443;
  kubePodCidr = "10.100.0.0/16";
in
{
  # this section is only required for longhorn
  systemd.services.containerd.path = [ pkgs.openiscsi "/run/wrappers/bin" "/run/current-system/sw/bin/" ];
  systemd.tmpfiles.rules = [
    "L+ /usr/local/bin - - - - /run/current-system/sw/bin/"
  ];

  boot.kernelModules = [ "br_netfilter" "overlay" "iptable_raw" "xt_socket" ];

  networking.extraHosts = "${kubeAPIServerIP} ${kubeAPIServerHostname}";
  networking.firewall.enable = lib.mkForce false;
  systemd.network.config = {
    networkConfig = {
      ManageForeignRoutes = false;
      ManageForeignRoutingPolicyRules = false;
    };
  };

  environment.systemPackages = with pkgs; [ cri-tools kubectl kubernetes ]
    ++ [ ethtool conntrack-tools iptables socat ] # for some k8s networking
    ++ [ openiscsi ]; # for longhorn

  systemd.services.kubelet.preStart = ""; # we do not want to pre-pull images or remove /opt/cni/bin/*
  services.prometheus.exporters.node.enable = lib.mkForce false; # we run node-exporter as a daemonset
  services.kubernetes = {
    masterAddress = kubeAPIServerHostname;
    apiserverAddress = "https://${kubeAPIServerHostname}:${toString kubeAPIServerPort}";
    apiserver = {
      securePort = kubeAPIServerPort;
      advertiseAddress = kubeAPIServerIP;
    };
    kubelet = {
      enable = true;
      taints = lib.mkForce { }; # we want to schedule some workloads on the master
      cni.packages = lib.mkForce [ ]; # we're using cilium for CNI, so we don't need this
    };
    clusterCidr = kubePodCidr;
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
        forward . 10.2.0.1
        cache 30
        loop
        reload
        loadbalance
      }
    '';
  };
}
