---
title: Apply a Kubernetes change
description: Change the manifests under clusters/, share a resource between the two clusters, validate the change, and make sure Flux applies it after the merge.
---

Use this runbook to change what runs on the `folly` or `offsite` cluster. Flux applies `clusters/` from `main` after the merge. A Flux Kustomization is a Flux object that applies one directory. A `kustomization.yaml` file lists what a Kustomize directory contains.

## Before you start

- Run `mise run devshell`.
- Get `kubectl` access to both clusters, as [Get cluster admin access](get-cluster-admin-access.md) describes.
- Give `--context <site>` to each `kubectl` and `flux` command. `<site>` is `folly` or `offsite`.
- To change a secret, you need the operator age key, as [Manage SOPS secrets](manage-sops-secrets.md) describes.

## Change a manifest

1. Edit the manifests under `clusters/<site>/` or `clusters/base/`.

> [!CAUTION]
> If Flux cannot parse a `${...}` in a file, it applies no object of that Flux Kustomization. An undefined `${VAR}` becomes empty.

2. For a value that is different on each cluster, use a `${VAR}` from `cluster-settings`, `cluster-topology` or `cluster-secrets`.
3. Make sure that the `postBuild.substituteFrom` of the parent Flux Kustomization lists that source.
4. If a file must keep a literal `${...}`, write it as `$${...}`.
5. If a ConfigMap holds many `${...}`, add the annotation `kustomize.toolkit.fluxcd.io/substitute: disabled` to it.
6. If the directory holds a `.sops.yaml` file, make sure that the parent Flux Kustomization decrypts it.

   ```yaml
   spec:
     decryption:
       provider: sops
       secretRef:
         name: sops-age
   ```

7. If the change adds a CRD, put the CRD in its own Flux Kustomization.
8. Add the CRD Flux Kustomization to the `dependsOn` of each Flux Kustomization that uses the CRD.
9. Put each `HelmRepository` or other Flux source next to the object that uses it.

> [!WARNING]
> Do not put a decrypted value in the wiki, a pull request or a log.

10. To change a secret, edit its `.sops.yaml` file with sops.

    ```bash
    SOPS_AGE_KEY_FILE=~/.config/age/keys.txt sops clusters/<site>/<path>/<name>.sops.yaml
    ```

    Result: sops opens the decrypted file in `$EDITOR`, and encrypts it again when you save.

## Share a resource between the clusters

If a resource is different on each cluster, such as a BGP peer or a Gateway listener, keep it in `clusters/<site>/`.

| Pattern | Example |
| --- | --- |
| A path in a `kustomization.yaml` of the cluster | `../../base/apps/reloader` in `clusters/folly/apps/kustomization.yaml` |
| For a shared controller, a Flux Kustomization in `clusters/base/flux-system/` that applies `clusters/base/platform/<name>` | `clusters/base/flux-system/cloudnative-pg.yaml` |
| For a cluster with no changes of its own, a Flux Kustomization with `spec.path` set to a `clusters/base/` directory | `clusters/offsite/flux-system/storage.yaml` |

1. Make a directory under `clusters/base/`.
2. In the directory, add a `kustomization.yaml` that lists each file.

> [!NOTE]
> Kustomize does not load a file from outside the directory of its `kustomization.yaml`.

3. Connect the directory to each cluster with a pattern from the table.
4. If you add a file to `clusters/base/flux-system/`, list it in `clusters/base/flux-system/kustomization.yaml`.

> [!NOTE]
> Only folly's `storage` and `monitoring` read `lab-topology`.

5. Make sure that each cluster substitutes each `${VAR}` and decrypts each `.sops.yaml` file in the directory.

## Validate the change

1. Render each directory that a Flux Kustomization applies.

   ```bash
   mise run k8s:render-apps
   ```

   Result: A `rendered <path>` line for each directory, and no `FAILED` line.

2. If the change edits a PrometheusRule, check the rules.

   ```bash
   mise run k8s:check-rules
   ```

   Result: `SUCCESS` for each rule file and each test file.

3. If the change adds a `${...}`, build the Flux Kustomization with substitution from the live cluster.

   ```bash
   flux build kustomization <name> --path clusters/<site>/<dir> \
     --kustomization-file clusters/<site>/flux-system/<name>.yaml --context <site> > /dev/null
   ```

   Result: The command prints no error.

4. Merge the change through a pull request.

## Make sure Flux applied the change

> [!NOTE]
> A Flux Kustomization applies the revision in the `infra` GitRepository. Before that source fetches the merge, a reconcile applies the old commit and reports success.

1. Fetch the merge commit into the `infra` GitRepository.

   ```bash
   flux --context <site> reconcile source git infra -n flux-system
   ```

   Result: `✔ fetched revision refs/heads/main@sha1:<sha>`.

2. Make sure that `<sha>` is the merge commit.
3. Apply the Flux Kustomization that holds the change.

   ```bash
   flux --context <site> reconcile kustomization <name> -n flux-system
   ```

   Result: `✔ applied revision refs/heads/main@sha1:<sha>`.

4. Make sure that each Flux Kustomization and HelmRelease is ready.

   ```bash
   flux --context <site> get kustomizations -A
   flux --context <site> get helmreleases -A
   ```

   Result: `READY` is `True` on each line.

5. If a HelmRelease did not upgrade, reconcile it.

   ```bash
   flux --context <site> reconcile helmrelease <name> -n <namespace>
   ```

   Result: `✔ applied revision <chart version>`.

6. Make sure that the new pods are `Running`.

   ```bash
   kubectl --context <site> get pods -n <namespace>
   ```

   Result: `STATUS` is `Running` on each new pod.

7. If the change is in `clusters/base/`, do steps 1 to 6 on the other cluster.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| The reconcile prints the old commit. | The `infra` source has not fetched the merge. | Run `flux --context <site> reconcile source git infra -n flux-system` again. |
| A Flux Kustomization shows `var substitution failed`. | A file has a `${...}` that Flux cannot parse. | Escape it as `$${...}`, or disable substitution for the ConfigMap. |
| A Flux Kustomization shows `no matches for kind`. | The CRD of that kind is not installed. | Do steps 7 and 8 of [Change a manifest](#change-a-manifest). |
| A Flux Kustomization shows `kustomization path not found`. | Its directory is deleted, but its Flux Kustomization is not. | Delete the Flux Kustomization from git. |
| A HelmRelease stays `False` after its retries. | The install or upgrade failed on each retry. | Correct the cause. Then reconcile it with `--reset`. |
| A value you changed with `kubectl` changes back. | Flux applies git again at each interval. | Make the change in git. |

## Related

- [How changes ship](../platform/how-changes-ship.md)
- [Kubernetes](../platform/kubernetes.md)
