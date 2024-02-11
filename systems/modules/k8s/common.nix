{ config, lib, pkgs, ... }:
let
  kubeAPIServerIP = "10.3.0.10";
  kubeAPIServerHostname = "k8s.lolwtf.ca";
  kubeAPIServerPort = 6443;
in
{
  # this section is only required for longhorn
  disabledModules = [ "virtualisation/containerd.nix" ];
  imports = [ ../../services/containerd.nix ];
  systemd.tmpfiles.rules = [
    "L+ /usr/local/bin - - - - /run/current-system/sw/bin/"
  ];

  boot = {
    kernelModules = [ "br_netfilter" "overlay" "iptable_raw" "xt_socket" ];
  };

  # networking.extraHosts = "${kubeAPIServerIP} ${kubeAPIServerHostname}";
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

  services.kubernetes = {
    masterAddress = kubeAPIServerHostname;
    apiserverAddress = "https://${kubeAPIServerHostname}:${toString kubeAPIServerPort}";
    apiserver = {
      securePort = kubeAPIServerPort;
      advertiseAddress = kubeAPIServerIP;
    };
    services.kubernetes = {
      kubelet.enable = true;
    };
  };

  virtualisation.containerd = {
    enable = true;
    settings = {
      version = 2;
      root = "/var/lib/containerd";
      state = "/run/containerd";
      oom_score = 0;

      grpc = {
        address = "/run/containerd/containerd.sock";
      };

      plugins."io.containerd.grpc.v1.cri" = {
        sandbox_image = "registry.k8s.io/pause:3.9";

        cni = {
          bin_dir = "/opt/cni/bin";
          max_conf_num = 1;
        };

        containerd.runtimes.runc = {
          runtime_type = "io.containerd.runc.v2";
          options.SystemdCgroup = true;
        };
      };
    };
  };
}
