{
  config,
  lib,
  pkgs,
  ...
}:
let
  networks = import ./networks.nix { inherit lib; };
  networkConfig = networks.${config.services.k8s.network};
  cfg = config.services.k8s;
  fmlIssuer = "https://oidc.lolwtf.ca/${cfg.network}";
  fmlSignerCert = ../../../terraform/pki/certs/${cfg.network}-sa-signer.pem;
  legacyIssuer = "https://kubernetes.default.svc";
  legacySignerCert = "/var/lib/kubernetes/secrets/service-account.pem";
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
    serviceAccountIssuerMigrationStage = lib.mkOption {
      type = lib.types.enum [
        "legacy"
        "dual-accept"
        "cutover"
      ];
      default = "legacy";
      description = ''
        FML ServiceAccount issuer rollout stage. Control planes must pass through
        dual-accept before cutover so existing tokens remain valid while the new
        verification key and issuer are introduced.
      '';
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

    # Add static host entries using the networkConfig directly to avoid circular dependency
    networking.extraHosts = "${networkConfig.apiServerIP} ${networkConfig.apiServerHostname}";

    # Control plane specific configuration
    services.etcd.enable = lib.mkIf (cfg.role == "control-plane") true;

    services.kubernetes = lib.mkMerge [
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
        easyCerts = true;
      }
      (lib.mkIf (cfg.role == "control-plane") {
        apiserver = {
          enable = true;
          allowPrivileged = true;
          extraSANs = [
            config.networking.hostName
            "${config.networking.hostName}.lolwtf.ca"
            "${config.networking.hostName}.${config.services.k8s.network}.lolwtf.ca"
            "${config.networking.hostName}.pirate-musical.ts.net"
            config.services.kubernetes.apiserver.advertiseAddress
          ];
          serviceAccountIssuer = lib.mkIf (cfg.serviceAccountIssuerMigrationStage == "cutover") fmlIssuer;
          serviceAccountKeyFile = lib.mkIf (
            cfg.serviceAccountIssuerMigrationStage == "cutover"
          ) fmlSignerCert;
          serviceAccountSigningKeyFile = lib.mkIf (
            cfg.serviceAccountIssuerMigrationStage == "cutover"
          ) config.sops.secrets."k8s-sa-signing-key".path;
          extraOpts = ''
            --enable-aggregator-routing=true \
            --requestheader-allowed-names=front-proxy-client \
            --requestheader-extra-headers-prefix=X-Remote-Extra- \
            --requestheader-group-headers=X-Remote-Group \
            --requestheader-username-headers=X-Remote-User
          ''
          + lib.optionalString (cfg.serviceAccountIssuerMigrationStage == "dual-accept") ''
            --service-account-issuer=${fmlIssuer} \
            --service-account-key-file=${fmlSignerCert}
          ''
          + lib.optionalString (cfg.serviceAccountIssuerMigrationStage == "cutover") ''
            --service-account-issuer=${legacyIssuer} \
            --service-account-key-file=${legacySignerCert}
          '';
        };
        controllerManager = {
          enable = true;
          serviceAccountKeyFile = lib.mkIf (
            cfg.serviceAccountIssuerMigrationStage == "cutover"
          ) config.sops.secrets."k8s-sa-signing-key".path;
        };
        scheduler.enable = true;
        addonManager.enable = false;
      })
    ];

  };

  systemd.services.kube-coredns-bootstrap = lib.mkIf (cfg.role == "control-plane") {
    description = "Bootstrap CoreDNS before Flux";
    wantedBy = [ "kubernetes.target" ];
    after = [ "kubernetes.target" ];
    path = with pkgs; [ kubectl ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };
    script = let
      clusterIP = builtins.head networkConfig.dns;
    in ''
      KUBECONFIG=/etc/kubernetes/cluster-admin.kubeconfig

      for i in $(seq 1 60); do
        kubectl get --raw /healthz &>/dev/null && break
        sleep 2
      done

      kubectl apply -f - <<'YAML'
apiVersion: v1
kind: ServiceAccount
metadata:
  name: coredns
  namespace: kube-system
  labels:
    k8s-app: kube-dns
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: system:coredns
  labels:
    k8s-app: kube-dns
rules:
- apiGroups: [""]
  resources: ["endpoints", "services", "pods", "namespaces"]
  verbs: ["list", "watch"]
- apiGroups: [""]
  resources: ["nodes"]
  verbs: ["get"]
- apiGroups: ["discovery.k8s.io"]
  resources: ["endpointslices"]
  verbs: ["list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: system:coredns
  labels:
    k8s-app: kube-dns
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: system:coredns
subjects:
- kind: ServiceAccount
  name: coredns
  namespace: kube-system
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns
  namespace: kube-system
data:
  Corefile: |
    .:53 {
        errors
        health { lameduck 10s }
        ready
        kubernetes cluster.local in-addr.arpa ip6.arpa {
            pods insecure
            fallthrough in-addr.arpa ip6.arpa
            ttl 30
        }
        prometheus :9153
        forward . ${networkConfig.upstreamDns}
        cache 30
        loop
        reload
        loadbalance
    }
---
apiVersion: v1
kind: Service
metadata:
  name: kube-dns
  namespace: kube-system
  labels:
    k8s-app: kube-dns
    kubernetes.io/cluster-service: "true"
  annotations:
    prometheus.io/scrape: "true"
    prometheus.io/port: "9153"
spec:
  clusterIP: ${clusterIP}
  ports:
  - name: dns
    port: 53
    protocol: UDP
    targetPort: 53
  - name: dns-tcp
    port: 53
    protocol: TCP
    targetPort: 53
  - name: metrics
    port: 9153
    protocol: TCP
    targetPort: 9153
  selector:
    k8s-app: kube-dns
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: coredns
  namespace: kube-system
  labels:
    k8s-app: kube-dns
    kubernetes.io/name: CoreDNS
spec:
  replicas: 1
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
  selector:
    matchLabels:
      k8s-app: kube-dns
  template:
    metadata:
      labels:
        k8s-app: kube-dns
    spec:
      priorityClassName: system-cluster-critical
      serviceAccountName: coredns
      tolerations:
      - key: CriticalAddonsOnly
        operator: Exists
      - effect: NoSchedule
        key: node-role.kubernetes.io/control-plane
      nodeSelector:
        kubernetes.io/os: linux
      containers:
      - name: coredns
        image: coredns/coredns:1.11.4
        imagePullPolicy: IfNotPresent
        args: ["-conf", "/etc/coredns/Corefile"]
        ports:
        - containerPort: 53
          name: dns
          protocol: UDP
        - containerPort: 53
          name: dns-tcp
          protocol: TCP
        - containerPort: 9153
          name: metrics
          protocol: TCP
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 60
          timeoutSeconds: 5
        readinessProbe:
          httpGet:
            path: /ready
            port: 8181
          initialDelaySeconds: 30
          timeoutSeconds: 5
        volumeMounts:
        - name: config-volume
          mountPath: /etc/coredns
          readOnly: true
        resources:
          limits:
            memory: 170Mi
          requests:
            cpu: 100m
            memory: 70Mi
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            add: ["NET_BIND_SERVICE"]
            drop: ["ALL"]
          readOnlyRootFilesystem: true
      dnsPolicy: Default
      volumes:
      - name: config-volume
        configMap:
          name: coredns
          items:
          - key: Corefile
            path: Corefile
YAML
    '';
  };
}
