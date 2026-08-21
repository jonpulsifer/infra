{
  config,
  lib,
  pkgs,
  ...
}:
let
  networks = import ./networks.nix { inherit lib; };
  networkConfig = networks.${config.services.k8s.network};
  fleet = import ../../lib/fleet.nix;
  cfg = config.services.k8s;
  fmlIssuer = "https://${fleet.oidcHost}/${cfg.network}";
  peerNetwork = if cfg.network == "folly" then "offsite" else "folly";
  peerIssuer = "https://${fleet.oidcHost}/${peerNetwork}";
  fmlSignerCert = ../../../terraform/pki/certs/${cfg.network}-sa-signer.pem;
  fmlClusterCaCert = ../../../terraform/pki/certs/${cfg.network}-ca.pem;
  fmlClusterCaBundle = ../../../terraform/pki/certs/${cfg.network}-ca-bundle.pem;
  fmlClusterCaChain = ../../../terraform/pki/certs/${cfg.network}-ca-chain.pem;
  cfsslCaPrefix = "${config.services.cfssl.dataDir}/ca";
in
{

  options.services.k8s = {
    enable = lib.mkEnableOption "Kubernetes";
    network = lib.mkOption {
      type = lib.types.enum [
        "folly"
        "offsite"
      ];
      description = "K8s network configuration";
    };
    role = lib.mkOption {
      type = lib.types.enum [
        "control-plane"
        "worker"
      ];
      description = "K8s node role";
      default = "worker";
    };
    clusterCa = {
      enable = lib.mkEnableOption "the repo-managed FML Kubernetes cluster CA";
    };
  };

  imports = [
    ./gvisor.nix
    ./longhorn.nix
  ];

  config = lib.mkIf cfg.enable {
    nixpkgs.overlays = [
      (import ../../overlays/certmgr.nix)
      (import ../../overlays/runc.nix)
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
    environment.etc."kubernetes/authentication-config.yaml".text = builtins.toJSON {
      apiVersion = "apiserver.config.k8s.io/v1";
      kind = "AuthenticationConfiguration";
      jwt = [
        {
          issuer = {
            url = peerIssuer;
            audiences = [ "api" ];
          };
          claimValidationRules = [
            {
              expression = ''
                claims.sub in [
                  "system:serviceaccount:atlantis:atlantis",
                  "system:serviceaccount:spindrift:spindrift"
                ]
              '';
              message = "only the Atlantis and Spindrift service accounts may authenticate across clusters";
            }
          ];
          claimMappings.username.expression = ''"federated:" + claims.sub'';
        }
      ];
    };

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
      ]; # for some k8s networking

    users.groups.kubelet = { };
    users.users.kubelet = {
      description = "Kubernetes kubelet user for user namespace support";
      isSystemUser = true;
      group = "kubelet";
      subUidRanges = [
        {
          startUid = 65536;
          count = 7208960;
        }
      ];
      subGidRanges = [
        {
          startGid = 65536;
          count = 7208960;
        }
      ];
    };
    systemd.services.kubelet.path = [ pkgs.shadow ];
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

    services.ddnsd.enable = false; # we use external-dns for cluster nodes
    services.prometheus.exporters.node.enable = false; # we run node-exporter as a daemonset

    services.certmgr.renewInterval = "21d"; # we want to check and renew certs every 3 weeks instead of every 30m

    systemd.tmpfiles.rules = lib.mkIf cfg.clusterCa.enable (
      [
        # kube-certmgr-bootstrap mkdir's the secrets dir as root inside
        # kubernetes-owned /var/lib/kubernetes. systemd-tmpfiles calls that
        # ownership change an unsafe path transition and silently skips every
        # rule underneath it, so the ca.pem link below never lands and the node
        # keeps trusting whichever CA was there first. Own the dir to match its
        # parent to keep the transition safe.
        "d /var/lib/kubernetes/secrets 0755 kubernetes kubernetes -"
        "L+ /var/lib/kubernetes/secrets/ca.pem - - - - ${fmlClusterCaBundle}"
      ]
      ++ lib.optional (cfg.role == "control-plane") "L+ ${cfsslCaPrefix}.pem - - - - ${fmlClusterCaCert}"
    );

    # Add static host entries using the networkConfig directly to avoid circular dependency
    networking.extraHosts = "${networkConfig.apiServerIP} ${networkConfig.apiServerHostname}";

    # Control plane specific configuration
    services.etcd.enable = lib.mkIf (cfg.role == "control-plane") true;

    services.kubernetes = lib.mkMerge [
      (lib.mkIf cfg.clusterCa.enable {
        caFile = "/var/lib/kubernetes/secrets/ca.pem";
        pki = {
          enable = true;
          caCertPathPrefix = cfsslCaPrefix;
          genCfsslCACert = false;
          pkiTrustOnBootstrap = false;
        };
      })
      {
        masterAddress = networkConfig.apiServerHostname;
        clusterCidr = networkConfig.podCidr;
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
          kubeconfig.server = config.services.kubernetes.apiserverAddress;
          taints = lib.mkForce { }; # we want to schedule workloads everywhere
        };

        proxy.enable = false;
        easyCerts = !cfg.clusterCa.enable;
      }
      (lib.mkIf (cfg.role == "control-plane") {
        apiserver = {
          enable = true;
          allowPrivileged = true;
          extraSANs = [
            config.networking.hostName
            "${config.networking.hostName}.${fleet.dnsZone}"
            "${config.networking.hostName}.${cfg.network}.${fleet.dnsZone}"
            "${config.networking.hostName}.${fleet.tailnet}"
            config.services.kubernetes.apiserver.advertiseAddress
          ];
          serviceAccountIssuer = fmlIssuer;
          serviceAccountKeyFile = fmlSignerCert;
          serviceAccountSigningKeyFile = config.sops.secrets."k8s-sa-signing-key".path;
          extraOpts = ''
            --authentication-config=/etc/kubernetes/authentication-config.yaml \
            --enable-aggregator-routing=true \
            --requestheader-allowed-names=front-proxy-client \
            --requestheader-extra-headers-prefix=X-Remote-Extra- \
            --requestheader-group-headers=X-Remote-Group \
            --requestheader-username-headers=X-Remote-User
          '';
        };
        controllerManager = {
          enable = true;
          serviceAccountKeyFile = config.sops.secrets."k8s-sa-signing-key".path;
          # --root-ca-file is what every pod receives as ca.crt, through the
          # kube-root-ca.crt ConfigMap. The cluster CA is not self-signed, so
          # on its own an OpenSSL client cannot build a path out of it and
          # fails with "unable to get issuer certificate" — Go accepts it only
          # because it treats any certificate in a trust store as an anchor.
          # The chain carries the cluster CA up to the self-signed root.
          #
          # Deliberately not caFile: that one also backs clientCaFile and
          # kubeletClientCaFile, where the FML anchors would let anything
          # issued under the FML Root authenticate to the API server.
          #
          # mkForce because nixpkgs assigns rootCaFile from the cfssl-issued
          # controller-manager client CA without mkDefault.
          rootCaFile = lib.mkIf cfg.clusterCa.enable (lib.mkForce fmlClusterCaChain);
        };
        scheduler.enable = true;
        addonManager.enable = false;
      })
    ];

  };
}
