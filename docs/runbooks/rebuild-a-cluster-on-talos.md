---
title: Rebuild a cluster on Talos
description: Replace a cluster's NixOS nodes with Talos Linux, bootstrap a fresh etcd, install Cilium and Flux, and restore the data that has a backup.
---

Use this runbook to move a cluster from NixOS to Talos Linux with a fresh etcd and a new, self-signed Kubernetes CA. The service-account signing key is imported, so the issuer, GCP workload identity and cross-cluster federation stay the same. Node-local data comes back only from a CloudNativePG or Velero backup.

> [!WARNING]
> This procedure changes live state by hand. It is an exception to the GitOps rule because no controller runs until Flux does. The owner applies `clusters/<site>/talos/` and `clusters/<site>/bootstrap/` once, and Atlantis owns them from the next pull request.

## Before you start

- Run `mise run devshell`, and sign in to `op`.
- Set `OP_ACCOUNT` to your 1Password sign-in address. The `onepassword` provider of `clusters/<site>/talos/` and `clusters/<site>/bootstrap/` then uses the desktop app.

  ```bash
  export OP_ACCOUNT=<sign-in address>
  ```

- Set `SOPS_AGE_KEY_FILE` to the operator key, as [Manage SOPS secrets](manage-sops-secrets.md) describes.
- You need write access to objects in the `homelab-ng` state bucket.
- On folly, `main` must hold the `monitoring-crds` Flux Kustomization, as [Adopt the folly Prometheus Operator CRDs](adopt-the-folly-prometheus-operator-crds.md) describes.
- `clusters/offsite/apps/atlantis/kubeconfig-hook.sh` and Rowbutt must read the CA only from `clusters/<site>/config/kubernetes-ca.pem`, not `terraform/pki/certs/`.
- On folly, `MATE_SANDBOX_LAB_JUMP` in `clusters/offsite/apps/mate/deployment.yaml` on `main` must not name a folly node, and that change must be deployed. A Talos node runs no sshd, so Rowbutt loses its Lab Net SSH when that node leaves NixOS.
- Open the cutover pull request as a draft: the Talos root, the Talos values in `clusters/<site>/networking/cilium/helm-release.yaml` and `clusters/<site>/config/cluster-settings.yaml`, and a new `serverName` for each CloudNativePG `Cluster`.

`<site>` is `folly` or `offsite`, and `<checkout>` is a checkout of the cutover branch. `<cp>` is `API_SERVER_IP` in `clusters/<site>/config/cluster-topology.json`.

## Freeze the cluster

> [!NOTE]
> The flux-operator can resume its own Kustomization. The old cluster stops when its control plane leaves NixOS.

1. Stop Flux on the old cluster, so that it does not undo the next step.

   ```bash
   flux --context <site> -n flux-system suspend kustomization --all
   ```

2. Stop the writers of each database. On folly, that is the `tronbyt` Deployment.

   ```bash
   kubectl --context folly -n tronbyt scale deploy/tronbyt --replicas 0
   ```

3. Take a last barman backup of each database, as [Recover a re-created database](recover-a-re-created-database.md#take-a-last-backup) describes.
4. Make sure that the newest `daily` Velero backup holds each volume that you restore.

   ```bash
   velero backup describe <backup> --details --kubecontext <site>
   ```

   Result: A `Pod Volume Backups` list with each volume and the phase `Completed`.

5. Record the kthx engine's releases on the cluster. Flux does not recreate them.

   ```bash
   kubectl --context <site> -n spindrift-apps get hr
   ```

## Make the secrets bundle

The owner does this section, because it decrypts the signing key.

1. Make the bundle and pin its CA in the cutover pull request, as [Make a Talos secrets bundle](make-a-talos-secrets-bundle.md) describes. It sets `secrets_item_uuid` and issues the admin talosconfig.

## Install the control plane

1. Create the Image Factory schematic, and read its ID.

   ```bash
   cd <checkout>
   tofu -chdir=clusters/<site>/talos init
   tofu -chdir=clusters/<site>/talos apply -target=module.talos.talos_image_factory_schematic.this
   tofu -chdir=clusters/<site>/talos output -raw schematic_id
   ```

2. Boot the control plane into the Talos installer, as [Install Talos on a node](install-talos-on-a-node.md) describes.
3. Mark the cutover pull request ready, and wait for the Atlantis plan comment. Then merge it with the admin bypass. No NixOS control plane is left to apply it, and `atlantis/apply` stays pending because the plan has creates. Do not comment `atlantis apply`.

   ```bash
   gh pr ready <number>
   gh pr merge <number> --admin --merge
   ```

4. Apply the control plane, and create etcd.

   ```bash
   tofu -chdir=clusters/<site>/talos apply -lock-timeout=10m \
     -target=module.talos.talos_machine.controlplane -target=module.talos.talos_cluster.this
   ```

   Result: `talos_cluster.this: Creation complete`.

5. If `talos_cluster` times out, bootstrap etcd by hand. Then do step 4 again.

   ```bash
   talosctl --context <site> -n <cp> bootstrap
   ```

## Join the workers

1. Boot each worker into the Talos installer, as [Install Talos on a node](install-talos-on-a-node.md) describes.
2. Apply the root.

   ```bash
   tofu -chdir=clusters/<site>/talos apply -lock-timeout=10m
   ```

   Result: `Apply complete!`. Each node registers `NotReady` about one minute later.

3. Write a kubeconfig context named `<site>`.

   ```bash
   talosctl --context <site> -n <cp> kubeconfig --force-context-name <site> --force
   ```

## Install the CNI and Flux

Cilium's values need the Prometheus Operator CRDs, and its chart renders the `cilium` GatewayClass only when the Gateway API CRDs exist. Flux needs pod networking. Flux adopts both Helm releases and the Gateway API CRDs.

1. Install the Prometheus Operator CRDs.

   ```bash
   helm --kube-context <site> install prometheus-operator-crds prometheus-operator-crds \
     --repo https://prometheus-community.github.io/helm-charts \
     --version "$(yq '.spec.chart.spec.version' clusters/base/monitoring-crds/prometheus-operator-crds.yaml)" \
     -n flux-system --create-namespace --set 'crds.annotations.helm\.sh/resource-policy=keep'
   ```

2. Install the Gateway API CRDs at the tag that the `gateway-api` GitRepository pins.

   ```bash
   kubectl --context <site> create -k \
     "https://github.com/kubernetes-sigs/gateway-api/config/crd/experimental?ref=$(yq '.spec.ref.tag' clusters/<site>/networking/git-repository-gateway-api.yaml)"
   kubectl --context <site> wait --for condition=established crd/gatewayclasses.gateway.networking.k8s.io --timeout 5m
   ```

3. Render `clusters/<site>/networking` as Flux does. The decrypted values stay in the shell and on `/dev/shm`.

   ```bash
   cd <checkout>; set -a
   eval "$(jq -r '.data | to_entries[] | "\(.key)=\(.value | @sh)"' clusters/<site>/config/cluster-topology.json)"
   eval "$(yq -o shell '.data' clusters/base/cluster-settings.yaml)"
   eval "$(yq -o shell '.data' clusters/<site>/config/cluster-settings.yaml)"
   eval "$(sops -d --extract '["stringData"]' clusters/<site>/config/cluster-secrets.sops.yaml | yq -o shell)"
   set +a
   kubectl kustomize clusters/<site>/networking | flux envsubst --strict > /dev/shm/networking.yaml
   ```

4. Install Cilium.

   ```bash
   yq 'select(.kind == "HelmRelease" and .metadata.name == "cilium") | .spec.values' /dev/shm/networking.yaml \
     | helm --kube-context <site> install cilium oci://quay.io/cilium/charts/cilium -n kube-system -f - \
         --version "$(yq '.spec.ref.tag' clusters/<site>/networking/cilium/oci-repository.yaml)"
   ```

5. Create the pod IP pool, then delete the render.

   ```bash
   kubectl --context <site> wait --for condition=established crd/ciliumpodippools.cilium.io --timeout 5m
   yq 'select(.kind == "CiliumPodIPPool")' /dev/shm/networking.yaml | kubectl --context <site> create -f -
   rm /dev/shm/networking.yaml
   ```

   Result: Each node is `Ready` within a few minutes.

6. Create the Secret `sops-age` with the operator key. Flux decrypts with it, and git does not declare it.

   ```bash
   kubectl --context <site> -n flux-system create secret generic sops-age --from-file=age.agekey="$SOPS_AGE_KEY_FILE"
   ```

   Result: `secret/sops-age created`.

7. Apply the bootstrap root. It installs CoreDNS and Flux. Talos labels the nodes, so `node-labels.tf` only forgets the old labels.

   ```bash
   tofu -chdir=clusters/<site>/bootstrap init
   tofu -chdir=clusters/<site>/bootstrap apply
   ```

8. Make sure that Flux applies `main`.

   ```bash
   flux --context <site> get kustomizations
   flux --context <site> get helmreleases -A
   ```

   Result: Each row is `True`. Each Cilium pod restarts once when Flux adopts the release.

## Restore the data

1. Make sure that each database recovers, as [Check the recovery](recover-a-re-created-database.md#check-the-recovery) describes, including its base backup under the new prefix. The cutover pull request declares each new `serverName`, so Flux creates each `Cluster` with its recovery. On folly, that is `tronbyt` in `clusters/folly/apps/tronbyt/04-database.yaml`.
2. Restore each volume from step 4 of the freeze, as [Restore a volume](restore-a-volume.md) describes.

> [!NOTE]
> Flux does not recreate kthx engine objects, and no runbook covers the recovery of an engine Datastore. The engine owns its namespaces and releases, so never create them by hand.

3. Deploy each App from step 5 of the freeze again, in the kthx console. Then make sure that the engine created its release.

   ```bash
   kubectl --context <site> -n spindrift-apps get hr
   ```

   Result: Each release from the freeze is `True`.

4. On offsite, recover the `clankerbanker` Datastore in `spindrift-datastores` from its barman archive.

## Finish

1. Rebase each open pull request. Atlantis reads the CA pin from the pull request's checkout.
2. Do the checks in [Verify a Talos cluster](verify-a-talos-cluster.md).
3. Comment `atlantis plan -d clusters/<site>/talos` on a pull request.

   Result: `No changes`.

4. After the first Talos snapshot, delete the NixOS ones under the old control plane's hostname. Set the Garage remote as [Restore etcd on Talos](restore-etcd-on-talos.md#get-the-snapshot) does.

   ```bash
   rclone purge garage:etcd/<control-plane>/
   ```

5. In a pull request, remove the cluster's hosts from `nix/hosts/default.nix` and its CA files from `terraform/pki/certs/`. Keep `<site>-sa-signer.pem`, which the JWKS reads.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| The plan fails with `Create the talos-<site>-secrets Secure Note`. | `secrets_item_uuid` is the placeholder. | Make the bundle. |
| A local `tofu apply` fails with `Error acquiring the state lock`. | An Atlantis plan holds the lock. | Wait for the plan comment, then apply again. If no plan runs, do [Release a stale state lock](release-a-stale-state-lock.md). |
| A Flux Kustomization fails with `secret "sops-age" not found`. | The Secret was not created. | Do step 6 of [Install the CNI and Flux](#install-the-cni-and-flux). |
| The `cilium` HelmRelease shows `MissingRollbackTarget`. | The upgrade timed out before both operator replicas had a node. | Run `flux --context <site> reconcile hr cilium -n kube-system --reset --force`. |
| The bootstrap root plans changes to `kubernetes_labels.nodes`. | `node-labels.tf` still declares the resource. | Replace it with a `removed` block, as `clusters/folly/bootstrap/node-labels.tf` does. |
| Atlantis, Rowbutt or the kthx engine fails TLS to the API server. | `kubernetes-ca.pem` holds the old CA, or a pull request predates it. | Pin the new CA, as [Make a Talos secrets bundle](make-a-talos-secrets-bundle.md#pin-the-new-ca) describes, or rebase the pull request. |

## Related

- [Make a Talos secrets bundle](make-a-talos-secrets-bundle.md)
- [Install Talos on a node](install-talos-on-a-node.md)
- [Verify a Talos cluster](verify-a-talos-cluster.md)
- [Restore etcd on Talos](restore-etcd-on-talos.md)
- [OpenTofu](../platform/opentofu.md)
