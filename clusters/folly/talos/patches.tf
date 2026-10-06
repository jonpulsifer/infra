# folly's patches on top of the module's. Each list entry is one patch file,
# and a singleton kind may appear once per file.

locals {
  dns_zone = jsondecode(file("${path.module}/../../../terraform/network/tailscale/fleet.tf.json")).locals.fleet.dns_zone

  # With the imported signing key, the published JWKS under this issuer stays
  # valid, so GCP workload identity and offsite's trust in folly survive.
  issuer = "https://oidc.${local.dns_zone}/${module.topology.data.CLUSTER_NAME}"
  # folly admits these offsite service-account tokens.
  peer_issuer = "https://oidc.${local.dns_zone}/offsite"

  cluster_patches = [
    # gVisor and hostUsers: false pods need user namespaces, which Talos
    # caps at 0. The other two keep the limits the workloads run under.
    yamlencode({
      apiVersion = "v1alpha1"
      kind       = "SysctlConfig"
      params = {
        "user.max_user_namespaces"    = "11255"
        "fs.inotify.max_user_watches" = "524288"
        "vm.max_map_count"            = "1048576"
      }
    }),
    # Unset means false in this document, unlike the generator's default.
    yamlencode({
      apiVersion                          = "v1alpha1"
      kind                                = "KubeletConfig"
      defaultRuntimeSeccompProfileEnabled = true
    }),
    # Mounted at /var/mnt/data: the local-path volumes and the hostPath trees.
    yamlencode({
      apiVersion = "v1alpha1"
      kind       = "UserVolumeConfig"
      name       = "data"
      provisioning = {
        diskSelector = { match = "system_disk" }
        minSize      = "100GiB"
        grow         = true
      }
      filesystem = { type = "xfs" }
    }),
    # The ports of Vector's loopback socket sources. machine.logging has no
    # 1.14 document, so it stays a v1alpha1 fragment.
    join("\n---\n", [
      yamlencode({
        machine = {
          logging = {
            destinations = [{ endpoint = "tcp://127.0.0.1:6050/", format = "json_lines" }]
          }
        }
      }),
      yamlencode({
        apiVersion = "v1alpha1"
        kind       = "KmsgLogConfig"
        name       = "vector"
        url        = "tcp://127.0.0.1:6051/"
      }),
    ]),
  ]

  controlplane_patches = [
    yamlencode({
      apiVersion = "v1alpha1"
      kind       = "KubeServiceAccountConfig"
      issuer     = { issuerURL = local.issuer }
      accepted   = { audiences = ["api", "https://kubernetes.default.svc"] }
    }),
    # A configuration file replaces Talos's anonymous flag, so the probe paths
    # are restated. The jwt entry admits the peer cluster's listed accounts.
    yamlencode({
      apiVersion = "v1alpha1"
      kind       = "KubeAuthenticationConfig"
      configuration = {
        anonymous = {
          enabled    = true
          conditions = [{ path = "/livez" }, { path = "/readyz" }, { path = "/healthz" }]
        }
        jwt = [{
          issuer = { url = local.peer_issuer, audiences = ["api"] }
          claimValidationRules = [{
            expression = <<-CEL
              claims.sub in [
                "system:serviceaccount:atlantis:atlantis",
                "system:serviceaccount:mate:mate-sandbox-admin",
                "system:serviceaccount:mate:mate-sandbox-reader",
                "system:serviceaccount:spindrift:spindrift"
              ]
            CEL
            message    = "only the Atlantis, Rowbutt sandbox (admin and reader) and Spindrift service accounts may authenticate across clusters"
          }]
          claimMappings = { username = { expression = "\"federated:\" + claims.sub" } }
        }]
      }
    }),
    # Fixed at first provisioning: a full EPHEMERAL cannot take etcd with it,
    # and restore-etcd wipes only this volume.
    yamlencode({
      apiVersion = "v1alpha1"
      kind       = "VolumeConfig"
      name       = "ETCD"
      provisioning = {
        diskSelector = { match = "system_disk" }
        minSize      = "8GiB"
        maxSize      = "8GiB"
      }
    }),
    # A talos.dev ServiceAccount in backups may take etcd snapshots. Each role
    # or namespace added here widens what a pod there can do on the node.
    yamlencode({
      apiVersion                  = "v1alpha1"
      kind                        = "KubeTalosAPIAccessConfig"
      allowedRoles                = ["os:etcd:backup"]
      allowedKubernetesNamespaces = ["backups"]
    }),
    # The three static pods serve metrics on the node address. A custom
    # listen-metrics-urls keeps etcd's on plain HTTP 2381.
    join("\n---\n", [
      yamlencode({
        cluster = {
          etcd = {
            extraArgs = { "listen-metrics-urls" = "http://0.0.0.0:2381" }
          }
        }
      }),
      yamlencode({
        apiVersion = "v1alpha1"
        kind       = "KubeControllerManagerConfig"
        extraArgs  = { "bind-address" = "0.0.0.0" }
      }),
      yamlencode({
        apiVersion = "v1alpha1"
        kind       = "KubeSchedulerConfig"
        extraArgs  = { "bind-address" = "0.0.0.0" }
      }),
    ]),
  ]

  # EPHEMERAL's cap differs per node; the data volume takes what is left.
  ephemeral_patch = { for name, n in local.nodes : name => yamlencode({
    apiVersion   = "v1alpha1"
    kind         = "VolumeConfig"
    name         = "EPHEMERAL"
    provisioning = { maxSize = n.ephemeral }
  }) }
}
