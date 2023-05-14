{ config, lib, pkgs, ... }:
{
  boot = {
    kernelModules = [ "br_netfilter" "overlay" ];
    kernel.sysctl = {
      "net.ipv4.ip_forward" = 1;
      "net.bridge.bridge-nf-call-iptables" = 1;
      "net.bridge.bridge-nf-call-ip6tables" = 1;
    };
  };

  networking.firewall.enabled = lib.mkForce false;
  systemd.network.config = {
    networkConfig = {
      ManageForeignRoutes = false;
      ManageForeignRoutingPolicyRules = false;
    };
  };

  environment.systemPackages = with pkgs; [ cri-tools kubernetes ] ++ [ ethtool conntrack-tools iptables socat ];
  services.prometheus.exporters.node.enable = lib.mkForce false;
  services.kubernetes = {
    masterAddress = "nuc";
    kubelet.enable = false;
    proxy.enable = false;
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

        containerd = {
          runtimes.runc.runtime_type = "io.containerd.runc.v2";
          runtimes.runc.options.SystemdCgroup = true;
        };
      };
    };
  };

  systemd.services.kubelet = {
    description = "kubelet: The Kubernetes Node Agent";
    documentation = [ "https://kubernetes.io/docs/home/" ];
    wantedBy = [ "multi-user.target" ];

    path = with pkgs; [
      gitMinimal
      openssh
      util-linux
      iproute2
      ethtool
      thin-provisioning-tools
      iptables
      socat
    ];

    serviceConfig = {
      StateDirectory = "kubelet";

      Environment = [
        "KUBELET_KUBECONFIG_ARGS=\"--bootstrap-kubeconfig=/etc/kubernetes/bootstrap-kubelet.conf --kubeconfig=/etc/kubernetes/kubelet.conf\""
        "KUBELET_CONFIG_ARGS=--config=/var/lib/kubelet/config.yaml"
      ];

      EnvironmentFile = [
        "-/var/lib/kubelet/kubeadm-flags.env"
        "-/etc/default/kubelet"
      ];

      Restart = "always";
      RestartSec = 10;

      ExecStart = "${pkgs.kubernetes}/bin/kubelet $KUBELET_KUBECONFIG_ARGS $KUBELET_CONFIG_ARGS $KUBELET_KUBEADM_ARGS $KUBELET_EXTRA_ARGS";
    };
  };
}
