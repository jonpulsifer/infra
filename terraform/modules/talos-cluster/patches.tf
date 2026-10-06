# Multi-document (Talos 1.14) strategic-merge patches. A patch document that
# the generated config lacks is appended; a matching kind is merged; a
# singleton kind may appear once per patch file, so every KubeNodeConfig
# field for a node lives in that node's own patch.

locals {
  # The public DNS zone, from the fleet facts file (nix/lib/fleet.nix reads
  # the same file). Never a literal.
  dns_zone = jsondecode(file("${path.module}/../../network/tailscale/fleet.tf.json")).locals.fleet.dns_zone

  # Every node: no Flannel, CIDRs and the kubelet resolver address from the
  # topology ConfigMap.
  cluster_patch = join("\n---\n", [
    yamlencode({
      apiVersion = "v1alpha1"
      kind       = "KubeFlannelCNIConfig"
      "$patch"   = "delete"
    }),
    yamlencode({
      apiVersion     = "v1alpha1"
      kind           = "KubeNetworkConfig"
      podSubnets     = [local.topology.CILIUM_POD_CIDR]
      serviceSubnets = [local.topology.SERVICE_CIDR]
    }),
    yamlencode({
      apiVersion = "v1alpha1"
      kind       = "KubeletConfig"
      clusterDNS = [local.topology.CLUSTER_DNS]
    }),
    yamlencode({
      apiVersion        = "v1alpha1"
      kind              = "SecurityProfileConfig"
      workloadIsolation = var.workload_isolation
    }),
    # CoreDNS forwards to ROUTER_IP itself, so no pod resolves through the
    # host DNS proxy, whose BPF-masquerade trap then never applies.
    yamlencode({
      apiVersion = "v1alpha1"
      kind       = "ResolverConfig"
      hostDNS = {
        enabled              = true
        forwardKubeDNSToHost = false
      }
    }),
  ])

  # Control plane: no kube-proxy and no Talos CoreDNS (the bootstrap root's
  # kube-dns Service at CLUSTER_DNS is the resolver); Talos rejects both kinds
  # on a worker. Serving-cert SANs as today (nix/services/k8s/default.nix
  # extraSANs minus the dead tailnet name). Issuer, federation and apiserver
  # extraArgs arrive through var.controlplane_patches.
  controlplane_patch = join("\n---\n", [
    yamlencode({
      apiVersion = "v1alpha1"
      kind       = "KubeProxyConfig"
      enabled    = false
    }),
    yamlencode({
      apiVersion = "v1alpha1"
      kind       = "KubeCoreDNSConfig"
      enabled    = false
    }),
    yamlencode({
      apiVersion = "v1alpha1"
      kind       = "KubeAPIServerConfig"
      certExtraSANs = distinct(concat(
        [for name, n in local.controlplanes : name],
        [for name, n in local.controlplanes : "${name}.${local.dns_zone}"],
        [for name, n in local.controlplanes : "${name}.${local.topology.CLUSTER_NAME}.${local.dns_zone}"],
        [local.topology.API_SERVER_HOSTNAME, local.topology.API_SERVER_IP],
      ))
      extraArgs = {
        enable-aggregator-routing = "true"
      }
    }),
  ])

  # Per node: hostname, install target and the labels the bootstrap root
  # applies today. The control plane drops its taint and LB-exclusion label
  # (one schedulable control plane per cluster).
  node_patch = { for name, n in var.nodes : name => join("\n---\n", concat([
    # The generator emits auto: stable, and Talos rejects auto beside hostname.
    yamlencode({
      apiVersion = "v1alpha1"
      kind       = "HostnameConfig"
      auto       = "off"
      hostname   = name
    }),
    yamlencode({
      apiVersion = "v1alpha1"
      kind       = "UnattendedInstallConfig"
      installer  = { image = local.installer_image }
      provisioning = {
        diskSelector = { match = n.install }
        wipe         = true
      }
    }),
    yamlencode(merge(
      {
        apiVersion = "v1alpha1"
        kind       = "KubeNodeConfig"
        labels = merge(
          { "bgp-enabled" = "true" },
          n.role == "controlplane" ? { "node.kubernetes.io/exclude-from-external-load-balancers" = { "$patch" = "delete" } } : {},
        )
      },
      n.role == "controlplane" ? {
        taints = { "node-role.kubernetes.io/control-plane" = { "$patch" = "delete" } }
      } : {},
    )),
  ])) }
}
