tags:: runbook, kubernetes, monitoring, helm

- Use this before wiring folly's `monitoring` Flux `Kustomization` to a `monitoring-crds` dependency. It is a one-time, hand-run step against the live folly cluster — one of the few kinds this repo carves out an exception for, because Helm's ownership convention has no git-declared path: Helm decides whether to adopt a pre-existing object by reading labels and annotations off the *live* object, not off anything a `Kustomization` can express. [[Runbooks/OpenBao Bootstrap]] is the same shape of exception, for the same reason — a one-time bootstrap action git cannot express, done once and never repeated by drift-correcting machinery.
- # Situation
	- offsite hit a bootstrap deadlock: `clusters/base/monitoring/opentelemetry-collector-servicemonitor.yaml` is a raw `ServiceMonitor`, and Flux server-side dry-runs every object in a `Kustomization` before applying any of them. On a cluster with no `ServiceMonitor` CRD yet, the whole `monitoring` `Kustomization` was refused — including the kube-prometheus-stack `HelmRelease` that would have supplied the CRD. The fix was `clusters/base/monitoring-crds/`, a `HelmRelease` for the `prometheus-operator-crds` chart, wired in ahead of `monitoring` via `dependsOn` (see `clusters/offsite/flux-system/monitoring.yaml` and `clusters/offsite/flux-system/monitoring-crds.yaml`).
	- folly has the identical latent deadlock — a from-scratch rebuild of folly would wedge the same way — but it is not wired to `monitoring-crds` yet, because folly is not building from scratch: its 10 `monitoring.coreos.com` CRDs already exist, installed by kube-prometheus-stack's own bundled `crds/` directory. Helm installs a chart's `crds/` directory once, without ownership metadata, and never touches it again on upgrade. So folly's live CRDs carry only `helm.toolkit.fluxcd.io/name: prom-stack` and `helm.toolkit.fluxcd.io/namespace: monitoring` labels — no `app.kubernetes.io/managed-by: Helm` label, no `meta.helm.sh/release-name` / `meta.helm.sh/release-namespace` annotations.
	- `prometheus-operator-crds` is templates-based (`charts/crds/templates/`, not a `crds/` directory), so Helm owns what it installs — and Helm refuses to adopt a pre-existing resource that lacks that exact ownership metadata: `Unable to continue with install: CustomResourceDefinition "<name>" in namespace "" exists and cannot be imported into the current release: invalid ownership metadata; label validation error: missing key "app.kubernetes.io/managed-by": must be set to "Helm"`.
	- The stamp has to land before folly's `monitoring-crds` `HelmRelease` installs, or its first install fails with exactly that error and folly is back to a deadlocked `monitoring` `Kustomization` — the thing this procedure exists to avoid.
- # Preconditions
	- folly's live CRDs are the 10 under `monitoring.coreos.com`: `alertmanagerconfigs`, `alertmanagers`, `podmonitors`, `probes`, `prometheusagents`, `prometheuses`, `prometheusrules`, `scrapeconfigs`, `servicemonitors`, `thanosrulers`.
	- The release name and namespace below (`prometheus-operator-crds` / `flux-system`) must match `clusters/base/monitoring-crds/prometheus-operator-crds.yaml`'s `metadata.name` and `metadata.namespace` exactly — that is what offsite's live `HelmRelease` already uses, and Helm's adoption check is an exact match, not a prefix or a rename-tolerant one.
	- Confirm no `monitoring-crds` `HelmRelease` exists on folly yet (`flux --context folly get helmrelease -A | grep monitoring-crds` returns nothing). If one already exists, this procedure does not apply — the adoption already happened or is mid-flight.
- # Stamp ownership on the live CRDs
	- One-time, by hand, against the live folly cluster. This is metadata only — it does not change any CRD's schema, and no workload restarts.
	- ```bash
	  CRDS=(
	    alertmanagerconfigs.monitoring.coreos.com
	    alertmanagers.monitoring.coreos.com
	    podmonitors.monitoring.coreos.com
	    probes.monitoring.coreos.com
	    prometheusagents.monitoring.coreos.com
	    prometheuses.monitoring.coreos.com
	    prometheusrules.monitoring.coreos.com
	    scrapeconfigs.monitoring.coreos.com
	    servicemonitors.monitoring.coreos.com
	    thanosrulers.monitoring.coreos.com
	  )

	  for crd in "${CRDS[@]}"; do
	    kubectl --context folly label crd "$crd" \
	      app.kubernetes.io/managed-by=Helm --overwrite
	    kubectl --context folly annotate crd "$crd" \
	      meta.helm.sh/release-name=prometheus-operator-crds \
	      meta.helm.sh/release-namespace=flux-system --overwrite
	  done
	  ```
- # Verify the stamp
	- Every CRD should report the label and both annotations back:
	- ```bash
	  for crd in "${CRDS[@]}"; do
	    kubectl --context folly get crd "$crd" -o jsonpath='{.metadata.name}{"\t"}{.metadata.labels.app\.kubernetes\.io/managed-by}{"\t"}{.metadata.annotations.meta\.helm\.sh/release-name}{"\t"}{.metadata.annotations.meta\.helm\.sh/release-namespace}{"\n"}'
	  done
	  ```
	- Expected output is 10 lines, each `<crd-name>	Helm	prometheus-operator-crds	flux-system`. Any line with an empty column means that CRD's stamp did not take — re-run the label/annotate pair for that name before moving on.
- # Wire folly to monitoring-crds (separate, reviewed PR)
	- Only after every CRD verifies clean above. This part is ordinary git-declared state — mirror offsite's wiring exactly, do not improvise a different shape:
	- Under `clusters/folly/`, add a `monitoring-crds` directory with a `kustomization.yaml` carrying `resources: [../../base/monitoring-crds]` — the same shape as `clusters/offsite/monitoring-crds/kustomization.yaml`.
	- Under `clusters/folly/flux-system/`, add a `monitoring-crds.yaml` `Kustomization` with `spec.path: ./clusters/folly/monitoring-crds` — the same shape as `clusters/offsite/flux-system/monitoring-crds.yaml`.
	- List that new file in `clusters/folly/flux-system/kustomization.yaml`'s `resources`, and add `dependsOn: [{name: monitoring-crds}]` to `clusters/folly/flux-system/monitoring.yaml` alongside its existing `dependsOn: storage`.
	- Merge and let Flux reconcile. Confirm the new `HelmRelease` adopted rather than recreated:
	- ```bash
	  flux --context folly get helmrelease prometheus-operator-crds -n flux-system
	  flux --context folly get kustomization monitoring-crds monitoring -n flux-system
	  ```
	- All three should report `Ready`. A `HelmRelease` stuck in `install retries exhausted` here means the ownership stamp is incomplete or wrong for at least one CRD — go back to the verify step above rather than deleting and recreating anything.
- # Rollback
	- If verification shows a bad stamp, re-run the label/annotate commands for the affected CRD names; both are `--overwrite` and idempotent, so re-running the full loop is always safe.
	- If the wiring PR ships and the `monitoring-crds` `HelmRelease` still fails ownership validation, the git-side wiring is safe to revert on its own — `git revert` the wiring PR and let Flux reconcile the removal. folly's `monitoring` `Kustomization` returns to its current unblocked state (no `dependsOn: monitoring-crds`), and the existing CRDs are untouched either way since nothing in that PR deletes them.
	- The ownership stamp itself is inert until a `HelmRelease` named `prometheus-operator-crds` in `flux-system` exists to claim it, so there is normally nothing to undo on the live cluster even if the wiring PR is abandoned. To fully undo the stamp anyway: `kubectl --context folly label crd "$crd" app.kubernetes.io/managed-by-` and `kubectl --context folly annotate crd "$crd" meta.helm.sh/release-name- meta.helm.sh/release-namespace-` for each name in `CRDS`.
