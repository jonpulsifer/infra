---
title: Verify a Talos cluster
description: Check a cluster that runs Talos after a rebuild or an upgrade, from the nodes and Cilium to federation, OpenBao, the sandbox runtimes, the GPU, NFS and Falco.
---

Use this runbook after [Rebuild a cluster on Talos](rebuild-a-cluster-on-talos.md), and after a Talos or Kubernetes upgrade. Each section checks one layer, so a failure points at its layer. Run the sections in order.

> [!WARNING]
> This procedure changes live state by hand. It is an exception to the GitOps rule because the gVisor check starts a pod that no manifest declares. The last step of that check deletes it.

## Before you start

- Get `kubectl` access, and the cluster's context in `~/.talos/config`, as [Get cluster admin access](get-cluster-admin-access.md) describes.

`<site>` is `folly` or `offsite`, and `<addr>` is a node's entry in `NODE_ADDRESSES` in `clusters/<site>/config/cluster-topology.json`.

## Check the nodes

1. Run the Talos health check against the control plane.

   ```bash
   talosctl --context <site> health
   ```

   Result: Each check ends in `OK`.

2. Make sure that each node is `Ready`.

   ```bash
   kubectl --context <site> get nodes -o wide
   ```

3. Make sure that each node has the sysctls from `clusters/<site>/talos/patches.tf`.

   ```bash
   talosctl --context <site> -n <addr> get kernelparamstatus | grep -E 'max_user_namespaces|max_user_watches|max_map_count'
   ```

   Result: `11255`, `524288` and `1048576`.

4. Make sure that local-path uses the `data` volume.

   ```bash
   kubectl --context <site> -n local-path-provisioner get configmap local-path-config -o jsonpath='{.data.config\.json}'
   ```

   Result: The path `/var/mnt/data`.

## Check the network

1. Read Cilium's status.

   ```bash
   kubectl --context <site> -n kube-system exec ds/cilium -- cilium-dbg status
   ```

   Result: `KubeProxyReplacement: True` and `Masquerading: BPF`.

2. Make sure that pod DNS resolves a cluster name and an external name.

   ```bash
   kubectl --context <site> -n kata-demo exec deploy/kata-demo -c nginx -- nslookup kubernetes.default.svc.cluster.local
   kubectl --context <site> -n kata-demo exec deploy/kata-demo -c nginx -- nslookup github.com
   ```

   Result: An address for each name.

3. Make sure that each node peers with the gateway.

   ```bash
   kubectl --context <site> -n kube-system exec ds/cilium -- cilium-dbg bgp peers
   ```

   Result: `established` for the gateway. [Inspect the UniFi network](inspect-the-unifi-network.md#read-bgp-on-the-folly-gateway) shows the gateway's side.

4. Make sure that each LoadBalancer Service has an address in `LB_RANGE`.

   ```bash
   kubectl --context <site> get svc -A --field-selector spec.type=LoadBalancer
   ```

> [!NOTE]
> Cilium starts before the Gateway API CRDs exist. Whether cilium-operator then serves the Gateway API without a restart is not known.

5. Make sure that the Gateway API works.

   ```bash
   kubectl --context <site> get gatewayclass,gateway -A
   ```

   Result: The class `cilium` is `Accepted`, and each Gateway is `Programmed`.

## Check identity

1. Make sure that the issuer and its key are the published ones.

   ```bash
   kubectl --context <site> get --raw /.well-known/openid-configuration | jq -r .issuer
   kubectl --context <site> get --raw /openid/v1/jwks | jq -r '.keys[].kid'
   jq -r '.keys[].kid' terraform/pki/oidc/<site>/jwks.json
   ```

   Result: `https://oidc.lolwtf.ca/<site>`, and the same key ID twice.

2. Comment `atlantis plan -d clusters/folly/bootstrap` on a pull request. Atlantis on offsite uses a federated token for folly.

   Result: A plan, with no `Unauthorized`.

3. On folly, make sure that OpenBao unsealed with its KMS key.

   ```bash
   kubectl --context folly -n vault exec vault-openbao-0 -- bao status
   ```

   Result: `Sealed false`.

> [!NOTE]
> The API server allows TLS 1.3 only, and anonymous `/version` returns 401. No client is known that needs either.

## Check the workloads

1. Make sure that a `kata-clh` pod runs its own kernel.

   ```bash
   kubectl --context <site> -n kata-demo exec deploy/kata-demo -c nginx -- uname -r
   ```

   Result: A kernel version without `-talos`.

> [!NOTE]
> The `kata-clh` overhead in `clusters/base/cluster-runtimeclass.yaml` is a NixOS measurement. Compare it with the `cloud-hypervisor` and `virtiofsd` memory in `talosctl -n <addr> processes`.

2. Start a gVisor pod, read its kernel, and delete it.

   ```bash
   kubectl --context <site> -n default run gv --image=nginx:alpine --overrides='{"spec":{"runtimeClassName":"gvisor"}}'
   kubectl --context <site> -n default wait --for=condition=Ready pod/gv
   kubectl --context <site> -n default exec gv -- uname -r
   kubectl --context <site> -n default delete pod gv
   ```

   Result: A kernel version that ends in `-gvisor`.

3. Make sure that no pod fails Pod Security.

   ```bash
   kubectl --context <site> get events -A | grep -i 'violates PodSecurity'
   ```

   Result: No output.

4. On folly, make sure that riptide offers its GPU, and that jellyfin runs on riptide.

   ```bash
   kubectl --context folly get node riptide -o jsonpath='{.status.allocatable.gpu\.intel\.com/i915}'
   kubectl --context folly -n jellyfin get pods -o wide
   ```

   Result: `1`, and a `Running` jellyfin pod on riptide.

5. Play a video in jellyfin that needs a transcode. Make sure that the dashboard shows hardware transcoding.
6. Make sure that the NFS volumes mount over NFSv4.2.

   ```bash
   talosctl --context <site> -n <addr> mounts | grep nfs
   ```

   Result: `nfs4` lines with `vers=4.2`.

7. Make sure that Falco runs on each node.

   ```bash
   kubectl --context <site> -n falco get pods -o wide
   ```

   Result: One `Running` pod for each node.

> [!NOTE]
> `clusters/folly/apps/falco/helm-release.yaml` allows the NixOS `.runc-wrapped` binary, which a Talos node does not have. The rule matches nothing there.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| `cilium-dbg bgp peers` shows no session. | The node lacks the `bgp-enabled` label, or the gateway has no neighbor for it. | Read the node's labels and `terraform/network/unifi/`. |
| No `cilium` GatewayClass. | cilium-operator started before the CRDs. | Run `kubectl --context <site> -n kube-system rollout restart deploy/cilium-operator`. |
| The federated plan shows `x509`. | The CA bundle lacks the cluster's new CA. | See [Rebuild a cluster on Talos](rebuild-a-cluster-on-talos.md). |
| A sandbox pod fails only on Talos. | Workload isolation. | Read `talosctl -n <addr> logs sandboxd`. |
| `bao status` shows `Sealed true`. | The KMS call failed. | Read the OpenBao pod's logs for the GCP error. |

## Related

- [Rebuild a cluster on Talos](rebuild-a-cluster-on-talos.md)
- [Install Talos on a node](install-talos-on-a-node.md)
- [Kubernetes](../platform/kubernetes.md)
