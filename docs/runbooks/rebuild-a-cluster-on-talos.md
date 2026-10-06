---
title: Rebuild a cluster on Talos
description: Replace a cluster's NixOS nodes with Talos Linux, bootstrap a fresh etcd, install Cilium and Flux, and restore the data that has a backup.
---

Use this runbook to move a cluster from NixOS to Talos Linux with a fresh etcd. The secrets bundle imports the service-account signing key, so the issuer, its JWKS, GCP workload identity and cross-cluster federation stay the same. The Kubernetes CA is new and self-signed. Node-local data comes back only from a CloudNativePG or Velero backup.

> [!WARNING]
> This procedure changes live state by hand. It is an exception to the GitOps rule because no controller runs until Flux does. The owner applies `clusters/<site>/talos/` and `clusters/<site>/bootstrap/` once, and Atlantis owns them from the next pull request.

## Before you start

- Run `mise run devshell`, and sign in to `op`.
- Set `SOPS_AGE_KEY_FILE` to the operator key, as [Manage SOPS secrets](manage-sops-secrets.md) describes.
- You need write access to objects in the `homelab-ng` state bucket.
- On folly, the `monitoring-crds` Flux Kustomization must exist. [Adopt the folly Prometheus Operator CRDs](adopt-the-folly-prometheus-operator-crds.md) adds it.
- Open the cutover pull request: the Talos values in `clusters/<site>/networking/cilium/helm-release.yaml` and `clusters/<site>/config/cluster-settings.yaml`, and a new `serverName` for each CloudNativePG `Cluster`.

`<site>` is `folly` or `offsite`, and `<checkout>` is a checkout of the cutover branch. `<cp>` is `API_SERVER_IP` in `clusters/<site>/config/cluster-topology.json`.

## Freeze the cluster

1. Take a last barman backup of each database, as [Recover a re-created database](recover-a-re-created-database.md#take-a-last-backup) describes.
2. Make sure that the newest `daily` Velero backup holds each volume that you restore.

   ```bash
   velero backup describe <backup> --details --kubecontext <site>
   ```

   Result: A `Pod Volume Backups` list with each volume and the phase `Completed`.

> [!NOTE]
> The flux-operator can resume its own Kustomization. The old cluster stops when its control plane leaves NixOS.

3. Stop Flux on the old cluster.

   ```bash
   flux --context <site> -n flux-system suspend kustomization --all
   ```

## Make the secrets bundle

> [!WARNING]
> The bundle holds every key of the cluster. Keep it on `/dev/shm`.

1. Make the bundle with the cluster's signing key. `<control-plane>` is `optiplex` or `retrofit`.

   ```bash
   umask 077; cd "$(mktemp -d -p /dev/shm talos.XXXX)"
   talosctl gen secrets --talos-version v1.14 -o secrets.yaml
   KEY=$(sops -d --extract '["k8s-sa-signing-key"]' <checkout>/nix/secrets/<control-plane>.sops.yaml | base64 -w0) \
     yq -i '.certs.k8sserviceaccount.key = strenv(KEY)' secrets.yaml
   ```

2. Store it as the Secure Note `talos-<site>-secrets`.

   ```bash
   op item template get "Secure Note" \
     | jq --rawfile n secrets.yaml '.title="talos-<site>-secrets" | .fields |= map(if .id=="notesPlain" then .value=$n else . end)' \
     | op item create --vault homelab --template - --format json | jq -r .id
   ```

   Result: The UUID of the item.

3. In the cutover pull request, set `secrets_item_uuid` in `clusters/<site>/talos/talos.tf` to the UUID.

> [!NOTE]
> Atlantis and Rowbutt trust the API server through `<site>-ca-bundle.pem`, which `scripts/pki/post-rotate.sh` rewrites without the Talos CA.

4. In the cutover pull request, add the new CA certificate to the bundle file.

   ```bash
   yq -r '.certs.k8s.crt' secrets.yaml | base64 -d >> <checkout>/terraform/pki/certs/<site>-ca-bundle.pem
   ```

5. Delete the directory.
6. Issue the admin talosconfig, as [Issue a talosconfig](issue-a-talosconfig.md) describes.

## Install the control plane

1. Create the Image Factory schematic, and read its ID.

   ```bash
   cd <checkout>
   tofu -chdir=clusters/<site>/talos init
   tofu -chdir=clusters/<site>/talos apply -target=module.talos.talos_image_factory_schematic.this
   tofu -chdir=clusters/<site>/talos output -raw schematic_id
   ```

2. Boot the control plane into the Talos installer, as [Install Talos on a node](install-talos-on-a-node.md) describes.
3. Merge the cutover pull request. The old control plane is gone, so nothing applies it to NixOS.
4. Apply the control plane, and create etcd.

   ```bash
   tofu -chdir=clusters/<site>/talos apply \
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
   tofu -chdir=clusters/<site>/talos apply
   ```

   Result: `Apply complete!`. Each node registers `NotReady` about one minute later.

3. Write a kubeconfig context named `<site>`.

   ```bash
   talosctl --context <site> -n <cp> kubeconfig --force-context-name <site> --force
   ```

## Install the CNI and Flux

Cilium's values need the Prometheus Operator CRDs, and Flux needs pod networking. Flux adopts both Helm releases.

1. Install the CRDs.

   ```bash
   helm --kube-context <site> install prometheus-operator-crds prometheus-operator-crds \
     --repo https://prometheus-community.github.io/helm-charts \
     --version "$(yq '.spec.chart.spec.version' clusters/base/monitoring-crds/prometheus-operator-crds.yaml)" \
     -n flux-system --create-namespace --set 'crds.annotations.helm\.sh/resource-policy=keep'
   ```

2. Render `clusters/<site>/networking` as Flux does. The decrypted values stay in the shell and on `/dev/shm`.

   ```bash
   cd <checkout>; set -a
   eval "$(jq -r '.data | to_entries[] | "\(.key)=\(.value | @sh)"' clusters/<site>/config/cluster-topology.json)"
   eval "$(yq -o shell '.data' clusters/base/cluster-settings.yaml)"
   eval "$(yq -o shell '.data' clusters/<site>/config/cluster-settings.yaml)"
   eval "$(sops -d --extract '["stringData"]' clusters/<site>/config/cluster-secrets.sops.yaml | yq -o shell)"
   set +a
   kubectl kustomize clusters/<site>/networking | flux envsubst --strict > /dev/shm/networking.yaml
   ```

3. Install Cilium.

   ```bash
   yq 'select(.kind == "HelmRelease" and .metadata.name == "cilium") | .spec.values' /dev/shm/networking.yaml \
     | helm --kube-context <site> install cilium oci://quay.io/cilium/charts/cilium -n kube-system -f - \
         --version "$(yq '.spec.ref.tag' clusters/<site>/networking/cilium/oci-repository.yaml)"
   ```

4. Create the pod IP pool, then delete the render.

   ```bash
   kubectl --context <site> wait --for condition=established crd/ciliumpodippools.cilium.io --timeout 5m
   yq 'select(.kind == "CiliumPodIPPool")' /dev/shm/networking.yaml | kubectl --context <site> create -f -
   rm /dev/shm/networking.yaml
   ```

   Result: Each node is `Ready` within a few minutes.

5. Apply the bootstrap root. It installs CoreDNS and Flux, and labels the nodes.

   ```bash
   tofu -chdir=clusters/<site>/bootstrap init
   tofu -chdir=clusters/<site>/bootstrap apply
   ```

6. Make sure that Flux applies `main`.

   ```bash
   flux --context <site> get kustomizations
   flux --context <site> get helmreleases -A
   ```

   Result: Each row is `True`. Each Cilium pod restarts once when Flux adopts the release.

## Restore the data

1. Recover each database with a barman archive, as [Recover a re-created database](recover-a-re-created-database.md) describes. On folly, that is `tronbyt`.
2. Restore each volume from step 2 of the freeze, as [Restore a volume](restore-a-volume.md) describes.

> [!NOTE]
> Flux does not recreate kthx engine objects. The engine re-asserts `bootstrap.initdb` as the field manager `spindrift`, and no runbook covers the recovery of an engine Datastore.

3. On offsite, recover the `clankerbanker` Datastore in `spindrift-datastores` from its barman archive.

## Finish

1. Do the checks in [Verify a Talos cluster](verify-a-talos-cluster.md).
2. Comment `atlantis plan -d clusters/<site>/talos` on a pull request.

   Result: `No changes`.

3. Remove the cluster's nodes from `nix/hosts/default.nix` in a pull request.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| The plan fails with `Create the talos-<site>-secrets Secure Note`. | `secrets_item_uuid` is the placeholder. | Do step 3 of the bundle procedure. |
| The `cilium` HelmRelease shows `MissingRollbackTarget`. | The upgrade timed out before both operator replicas had a node. | Run `flux --context <site> reconcile hr cilium -n kube-system --reset --force`. |
| The bootstrap root fails on `kubernetes_labels.nodes`. | A node has not registered. | Join the worker, then apply again. |
| Atlantis or Rowbutt fails TLS to the API server. | The CA bundle lacks the new CA. | Do step 4 of the bundle procedure. |

## Related

- [Install Talos on a node](install-talos-on-a-node.md)
- [Verify a Talos cluster](verify-a-talos-cluster.md)
- [Restore etcd on Talos](restore-etcd-on-talos.md)
- [OpenTofu](../platform/opentofu.md)
