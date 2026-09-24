---
title: Adopt the folly Prometheus Operator CRDs
description: Move folly's Prometheus Operator CRDs from the kube-prometheus-stack chart, which does not upgrade them, to a HelmRelease that owns and upgrades them.
---

folly's Prometheus Operator CRDs come from the kube-prometheus-stack chart, which does not upgrade them, so they fall behind the Prometheus Operator after each chart bump. Use this runbook once to give folly the `monitoring-crds` Flux Kustomization that offsite has. Its `prometheus-operator-crds` HelmRelease then owns and upgrades the ten `monitoring.coreos.com` CRDs, and folly's `monitoring` Flux Kustomization can depend on it. The merge adopts the existing CRDs, because helm-controller takes ownership of existing objects when it installs a release.

## Before you start

- Get `kubectl` access to folly, as [Get cluster admin access](get-cluster-admin-access.md) describes.
- Run `mise run devshell`.

## Check folly

1. Make sure that folly has no `prometheus-operator-crds` HelmRelease.

   ```bash
   flux --context folly get helmrelease prometheus-operator-crds -n flux-system
   ```

   Result: `✗ HelmRelease object 'prometheus-operator-crds' not found in "flux-system" namespace`.

2. If the HelmRelease exists, stop. folly already has the `monitoring-crds` Flux Kustomization.

> [!NOTE]
> folly's CRDs have no Helm ownership metadata. A helm-controller without the `disableTakeOwnership` field adopts only objects that have this metadata.

3. Make sure that helm-controller takes ownership of existing objects.

   ```bash
   kubectl --context folly explain helmrelease.spec.install.disableTakeOwnership
   ```

   Result: `FIELD: disableTakeOwnership <boolean>`, and a description that ends in `Defaults to false.`

4. If kubectl prints `field "disableTakeOwnership" does not exist`, stop.

## Give folly the monitoring-crds Flux Kustomization

1. Under `clusters/folly/`, make a `monitoring-crds` directory with this `kustomization.yaml`.

   ```yaml
   ---
   apiVersion: kustomize.config.k8s.io/v1beta1
   kind: Kustomization
   resources:
     - ../../base/monitoring-crds
   ```

2. Copy `clusters/offsite/flux-system/monitoring-crds.yaml` into `clusters/folly/flux-system/`.
3. In the copy, set `spec.path` to `./clusters/folly/monitoring-crds`.
4. Add `monitoring-crds.yaml` to `resources` in `clusters/folly/flux-system/kustomization.yaml`.
5. In `clusters/folly/flux-system/monitoring.yaml`, add `- name: monitoring-crds` under `dependsOn`, after `storage`.
6. In `clusters/folly/monitoring/kube-prometheus.yaml`, set `crds.enabled: false` under `values`, as offsite does.
7. Render the change.

   ```bash
   mise run k8s:render-apps
   ```

   Result: The output includes `rendered clusters/folly/monitoring-crds`.

> [!WARNING]
> The merge adopts the CRDs. If the install fails after that, helm-controller uninstalls the release, because `install.remediation.retries` is set. Helm then deletes the CRDs and every ServiceMonitor, PrometheusRule and other object of those kinds on folly.

8. Merge the change through a pull request.
9. Fetch the merge commit into the `infra` GitRepository.

   ```bash
   flux --context folly reconcile source git infra -n flux-system
   ```

   Result: `✔ fetched revision refs/heads/main@sha1:<sha>`.

10. Make sure that `<sha>` is the merge commit.
11. Apply the `infra` Flux Kustomization, which applies `clusters/folly/flux-system/`.

    ```bash
    flux --context folly reconcile kustomization infra -n flux-system
    ```

    Result: `✔ applied revision refs/heads/main@sha1:<sha>`.

12. Make sure that the three objects are ready.

    ```bash
    flux --context folly get kustomization monitoring-crds -n flux-system
    flux --context folly get helmrelease prometheus-operator-crds -n flux-system
    flux --context folly get kustomization monitoring -n flux-system
    ```

    Result: `READY` is `True` on each.

13. Make sure that the HelmRelease owns the CRDs.

    ```bash
    kubectl --context folly get crd -l helm.toolkit.fluxcd.io/name=prometheus-operator-crds \
      -o custom-columns='NAME:.metadata.name,MANAGED-BY:.metadata.labels.app\.kubernetes\.io/managed-by,RELEASE:.metadata.annotations.meta\.helm\.sh/release-name,NAMESPACE:.metadata.annotations.meta\.helm\.sh/release-namespace'
    ```

    Result: Ten rows. Each shows `Helm`, `prometheus-operator-crds` and `flux-system`.

14. In a new pull request, delete this runbook and the folly rule on [Kubernetes](../platform/kubernetes.md#rules).

## If something goes wrong

> [!WARNING]
> After the merge, do not delete or recreate the CRDs, and do not revert the change. A revert makes helm-controller uninstall the release. Each action deletes every ServiceMonitor, PrometheusRule and other object of those kinds on folly.

| Symptom | Cause | Action |
| --- | --- | --- |
| The HelmRelease shows `invalid ownership metadata`. | helm-controller did not take ownership, so Helm has adopted no CRD. | Revert the change. A revert deletes no CRD while Helm has adopted none. |

## Related

- [Kubernetes](../platform/kubernetes.md)
- [Observability](../platform/observability.md)
