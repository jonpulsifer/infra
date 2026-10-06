---
title: Adopt the folly Prometheus Operator CRDs
description: Make sure that folly's prometheus-operator-crds HelmRelease adopted the Prometheus Operator CRDs that kube-prometheus-stack installed.
---

folly has the `monitoring-crds` Flux Kustomization that offsite has. Its `prometheus-operator-crds` HelmRelease owns and upgrades the ten `monitoring.coreos.com` CRDs, and folly's `monitoring` and `networking` Flux Kustomizations depend on it. kube-prometheus-stack installed folly's CRDs from its `crds/` directory, without Helm ownership metadata. helm-controller takes ownership of existing objects when it installs a release, so the first install adopts them. Use this runbook once, after `main` first gives folly the `monitoring-crds` Flux Kustomization, to make sure that the adoption is complete.

## Before you start

- Get `kubectl` access to folly, as [Get cluster admin access](get-cluster-admin-access.md) describes.
- Run `mise run devshell`.

## Make sure that Flux adopted the CRDs

1. Fetch the latest `main` into the `infra` GitRepository.

   ```bash
   flux --context folly reconcile source git infra -n flux-system
   ```

   Result: `✔ fetched revision refs/heads/main@sha1:<sha>`.

2. Apply the `infra` Flux Kustomization, which applies `clusters/folly/flux-system/`.

   ```bash
   flux --context folly reconcile kustomization infra -n flux-system
   ```

   Result: `✔ applied revision refs/heads/main@sha1:<sha>`.

3. Make sure that the three objects are ready.

   ```bash
   flux --context folly get kustomization monitoring-crds -n flux-system
   flux --context folly get helmrelease prometheus-operator-crds -n flux-system
   flux --context folly get kustomization monitoring -n flux-system
   ```

   Result: `READY` is `True` on each.

4. Make sure that the HelmRelease owns the CRDs, and that Helm keeps them.

   ```bash
   kubectl --context folly get crd -l helm.toolkit.fluxcd.io/name=prometheus-operator-crds \
     -o custom-columns='NAME:.metadata.name,MANAGED-BY:.metadata.labels.app\.kubernetes\.io/managed-by,RELEASE:.metadata.annotations.meta\.helm\.sh/release-name,NAMESPACE:.metadata.annotations.meta\.helm\.sh/release-namespace,POLICY:.metadata.annotations.helm\.sh/resource-policy'
   ```

   Result: Ten rows. Each shows `Helm`, `prometheus-operator-crds`, `flux-system` and `keep`.

5. Make sure that the ServiceMonitors are still there.

   ```bash
   kubectl --context folly get servicemonitors -A --no-headers | wc -l
   ```

   Result: A number greater than zero.

6. In a new pull request, delete this runbook and the links to it.

## If something goes wrong

> [!WARNING]
> Do not delete or recreate the CRDs. Each action deletes every ServiceMonitor, PrometheusRule and other object of those kinds on folly.

| Symptom | Cause | Action |
| --- | --- | --- |
| The HelmRelease shows `invalid ownership metadata`. | helm-controller did not take ownership, so Helm adopted no CRD. | Revert the change. A revert deletes no CRD. |
| The HelmRelease shows an install failure. | Install remediation uninstalls the release. The `keep` resource policy leaves the CRDs in place. | Read the HelmRelease events with `kubectl --context folly describe helmrelease prometheus-operator-crds -n flux-system`. |
| `networking` or `monitoring` shows `dependency 'flux-system/monitoring-crds' is not ready`. | The `monitoring-crds` Flux Kustomization did not apply. | Read its status with `flux --context folly get kustomization monitoring-crds -n flux-system`. |

## Related

- [Kubernetes](../platform/kubernetes.md)
- [Observability](../platform/observability.md)
