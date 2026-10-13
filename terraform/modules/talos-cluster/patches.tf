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
  # on a worker. Serving-cert SANs are the node and API
  # server names. Issuer, federation and apiserver
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

  # The control plane drops its taint (one schedulable control plane per
  # cluster); a node's own taints are added. One map per node keeps the
  # conditional below to a single shape, which OpenTofu's type unification
  # of a conditional requires. Talos passes a taint to the kubelet, which
  # applies it when it registers the Node, and NodeRestriction refuses the
  # kubelet's later change: a taint declared for a registered node is applied
  # once by hand with kubectl taint.
  node_taints = { for name, n in var.nodes : name => merge(
    n.role == "controlplane" ? { "node-role.kubernetes.io/control-plane" = { "$patch" = "delete" } } : {},
    n.taints,
  ) }

  # Per node: hostname, install target, and its labels and taints. The
  # control plane drops its LB-exclusion label too.
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
    # The Talos API certificate names the hostname and addresses by itself;
    # the public name is what talosctl --nodes is given. machine.certSANs has
    # no 1.14 document, so it stays a v1alpha1 fragment.
    yamlencode({
      machine = { certSANs = ["${name}.${local.dns_zone}"] }
    }),
    yamlencode(merge(
      {
        apiVersion = "v1alpha1"
        kind       = "KubeNodeConfig"
        labels = merge(
          { "bgp-enabled" = "true" },
          n.role == "controlplane" ? { "node.kubernetes.io/exclude-from-external-load-balancers" = { "$patch" = "delete" } } : {},
          n.labels,
        )
      },
      length(local.node_taints[name]) > 0 ? { taints = local.node_taints[name] } : {},
    )),
  ])) }
}
