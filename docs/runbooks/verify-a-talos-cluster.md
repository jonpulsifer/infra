---
title: Verify a Talos cluster
description: Check a cluster that runs Talos after a rebuild or an upgrade, from the nodes and Cilium to federation, backups, OpenBao, the sandbox runtimes, the GPU, NFS and Falco.
---

Use this runbook after [Rebuild a cluster on Talos](rebuild-a-cluster-on-talos.md), and after a Talos or Kubernetes upgrade. Each section checks one layer, so a failure points at its layer. Run the sections in order.

> [!WARNING]
> This procedure changes live state by hand. It is an exception to the GitOps rule because the backup checks and the gVisor check create objects that no manifest declares. Each check deletes its object, or lets it expire.

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

4. Make sure that a pod verifies the API server with its own CA, that the CA is the pin, and that it is the only client CA.

   ```bash
   kubectl --context <site> -n kata-demo exec deploy/kata-demo -c nginx -- curl -s -o /dev/null -w '%{http_code}\n' \
     --cacert /var/run/secrets/kubernetes.io/serviceaccount/ca.crt https://kubernetes.default.svc/version
   kubectl --context <site> -n kube-system get cm kube-root-ca.crt -o jsonpath='{.data.ca\.crt}' | diff - clusters/<site>/config/kubernetes-ca.pem
   kubectl --context <site> -n kube-system get cm extension-apiserver-authentication -o jsonpath='{.data.client-ca-file}' | grep -c 'BEGIN CERT'
   ```

   Result: `401`, no `diff` output, and `1`.

5. On folly, make sure that the kthx engine reaches the API server after its restart, and that Rowbutt can run `kubectl --context folly get ns` in a sandbox.

   ```bash
   kubectl --context offsite -n spindrift logs deploy/spindrift-reconciler --since 1h | grep -ci x509
   ```

   Result: `0`.

> [!NOTE]
> The API server allows TLS 1.3 only, and anonymous `/version` returns 401. No client is known that needs either.

## Check the backups

`<namespace>` holds a pod with a `backup.velero.io/backup-volumes` annotation, such as `jellyfin` on folly.

1. Take the first etcd snapshot.

   ```bash
   kubectl --context <site> -n backups create job --from=cronjob/etcd-snapshot etcd-snapshot-first
   kubectl --context <site> -n backups wait --for=condition=complete job/etcd-snapshot-first --timeout=10m
   ```

   Result: `job.batch/etcd-snapshot-first condition met`. The Job expires after seven days.

2. Make sure that Velero backs up a pod volume from the kubelet root, then delete the backup.

   ```bash
   velero backup create verify-talos --include-namespaces <namespace> --wait --kubecontext <site>
   velero backup describe verify-talos --details --kubecontext <site>
   velero backup delete verify-talos --confirm --kubecontext <site>
   ```

   Result: A `Pod Volume Backups` list with the phase `Completed`.

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

8. Make sure that the kthx engine's releases on the cluster are ready.

   ```bash
   kubectl --context <site> -n spindrift-apps get hr
   ```

   Result: Each row is `True`. After a rebuild, each release from the freeze in [Move a cluster's data through a Talos rebuild](move-a-clusters-data-through-a-talos-rebuild.md#freeze-the-cluster) is there.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| `cilium-dbg bgp peers` shows no session. | The node lacks the `bgp-enabled` label, or the gateway has no neighbor for it. | Read the node's labels and `terraform/network/unifi/`. |
| No `cilium` GatewayClass. | Cilium was installed before the Gateway API CRDs, so its chart did not render the class. | Run `flux --context <site> reconcile hr cilium -n kube-system --force`, then `kubectl --context <site> -n kube-system rollout restart deploy/cilium-operator`. |
| The federated plan shows `x509`. | `clusters/<site>/config/kubernetes-ca.pem` holds the old CA, or the pull request predates it. | Pin the new CA, as [Make a Talos secrets bundle](make-a-talos-secrets-bundle.md#pin-the-new-ca) describes, or rebase the pull request. |
| The etcd snapshot Job fails in `snapshot`. | The Talos API refuses the role, or the Secret `etcd-snapshot-talos` is missing. | Read `kubectl -n backups get serviceaccounts.talos.dev etcd-snapshot-talos -o yaml` for its status. |
| A sandbox pod fails only on Talos. | Workload isolation. | Read `talosctl -n <addr> logs sandboxd`. |
| `bao status` shows `Sealed true`. | The KMS call failed. | Read the OpenBao pod's logs for the GCP error. |

## Related

- [Rebuild a cluster on Talos](rebuild-a-cluster-on-talos.md)
- [Install Talos on a node](install-talos-on-a-node.md)
- [Kubernetes](../platform/kubernetes.md)
