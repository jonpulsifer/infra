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
  cluster_patch = join("\n---\n", concat([
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
    # host DNS proxy, whose BPF-masquerade trap then never applies. A node
    # with a static address takes its resolvers and search domain from here,
    # as a DHCP lease would give them.
    var.static_addresses ? yamlencode(merge(local.resolver, {
      nameservers   = [for a in var.nameservers : { address = a }]
      searchDomains = { domains = [local.dns_zone] }
    })) : yamlencode(local.resolver),
  ], local.node_link_alias))

  resolver = {
    apiVersion = "v1alpha1"
    kind       = "ResolverConfig"
    hostDNS = {
      enabled              = true
      forwardKubeDNSToHost = false
    }
  }

  # A static address goes on the node's one physical NIC, which Talos names
  # by this alias whatever the kernel calls it. The selector matches every
  # physical link, so it names one only on a box with a single NIC; on a box
  # with two, Talos skips the alias and the node keeps its default DHCP.
  node_link          = "net0"
  node_prefix_length = tonumber(split("/", local.topology.K8S_NODE_CIDR)[1])
  node_link_alias = var.static_addresses ? [yamlencode({
    apiVersion = "v1alpha1"
    kind       = "LinkAliasConfig"
    name       = local.node_link
    selector   = { match = "true" }
  })] : []

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

  # Per node: hostname, install target, its labels and taints, and its
  # static address. The control plane drops its LB-exclusion label too.
  node_docs = { for name, n in var.nodes : name => concat([
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
      installer  = { image = local.node_installer_image[name] }
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
          contains(var.tpm_nodes, name) ? { "lolwtf.ca/tpm" = "true" } : {},
          n.labels,
        )
      },
      length(local.node_taints[name]) > 0 ? { taints = local.node_taints[name] } : {},
    )),
  ], local.node_link_config[name]) }

  # The node's address on its NIC and the default route through the gateway,
  # where Talos would otherwise run DHCP on the unconfigured link.
  node_link_config = { for name, n in var.nodes : name => var.static_addresses ? [yamlencode({
    apiVersion = "v1alpha1"
    kind       = "LinkConfig"
    name       = local.node_link
    up         = true
    addresses  = [{ address = "${n.address}/${local.node_prefix_length}" }]
    routes     = [{ gateway = local.topology.ROUTER_IP }]
  })] : [] }

  # A fresh install formats STATE and EPHEMERAL, so the install render of a
  # TPM node encrypts them. A running node keeps the volumes it was installed
  # with: Talos refuses to mount a plain volume that its config calls
  # encrypted, so only a node reinstalled encrypted carries the documents.
  node_patch_install = { for name, n in var.nodes : name => join("\n---\n", concat(
    local.node_docs[name],
    contains(var.tpm_nodes, name) ? concat(local.tpm_volume_patches, [local.tpm_no_kexec_patch]) : [],
  )) }
  node_patch = { for name, n in var.nodes : name => join("\n---\n", concat(
    local.node_docs[name],
    contains(var.tpm_nodes, name) ? [local.tpm_no_kexec_patch] : [],
    contains(var.encrypted_nodes, name) ? local.tpm_volume_patches : [],
  )) }

  # A kexec skips systemd-stub, which puts the UKI's PCR signing key in
  # /.extra, so the TPM cannot unseal STATE and the boot loops. With kexec off,
  # every reboot, the one after install included, goes through the firmware.
  tpm_no_kexec_patch = yamlencode({
    apiVersion = "v1alpha1"
    kind       = "SysctlConfig"
    params     = { "kernel.kexec_load_disabled" = "1" }
  })

  # A TPM node's STATE and EPHEMERAL are LUKS2 volumes whose key the TPM seals
  # to PCR 7 and to the PCR 11 policy signed by the UKI's PCR signing key.
  tpm_volume_patches = [for volume in ["STATE", "EPHEMERAL"] : yamlencode({
    apiVersion = "v1alpha1"
    kind       = "VolumeConfig"
    name       = volume
    encryption = {
      provider = "luks2"
      keys     = [{ slot = 0, tpm = {} }]
    }
  })]
}
