tags:: runbook, kubernetes, monitoring, helm

- Use this to wire folly onto the `monitoring-crds` Kustomization the same way [[Runbooks/Kubernetes GitOps Change]]'s GitOps rule normally requires — except the first step is a live, by-hand mutation. That is deliberate: see "The one sanctioned exception" below before running anything here.
- # Why folly needs this
	- Offsite installs the Prometheus Operator CRDs from a dedicated `monitoring-crds` Kustomization that its `monitoring` Kustomization `dependsOn`, fixing a Flux bootstrap deadlock: `clusters/base/monitoring/` carries a raw `ServiceMonitor`, Flux server-side dry-runs every object in a Kustomization before applying any of them, and without the CRD already on the cluster the whole `monitoring` Kustomization was refused — including the `kube-prometheus-stack` HelmRelease that would have supplied the CRD (fixed for offsite in #1788). See `clusters/base/monitoring-crds/` and `clusters/offsite/flux-system/monitoring-crds.yaml`.
	- Folly is not wired to `monitoring-crds` yet, and has the same latent deadlock on a from-scratch rebuild. It is not wired because `kube-prometheus-stack` ships its CRDs in a Helm `crds/` directory, which Helm installs without ownership metadata and never upgrades. Folly's existing CRDs — installed years ago through that path — carry no `app.kubernetes.io/managed-by: Helm` label and no `meta.helm.sh/release-*` annotations. Pointing folly's `monitoring-crds` Kustomization at the templates-based `prometheus-operator-crds` chart without first labeling those CRDs makes the chart try to create resources that already exist, and Helm refuses with "invalid ownership metadata" — the install fails, and `monitoring` stays blocked behind a Kustomization that never reaches Ready. Same deadlock shape, different trigger.
	- Adopting the ten existing CRDs into the chart's ownership is what breaks that, permanently, without a delete-and-recreate that would drop every `ServiceMonitor`, `PrometheusRule`, and friend in the cluster along with the CRD.
- # The one sanctioned exception
	- The repo's hard rule is: never mutate live infrastructure by hand, author desired state in git and let the operators apply it. This procedure's first step breaks that rule on purpose, because Helm's adoption metadata — the label and two annotations below — has no git-side representation. Nothing in `clusters/` can set them; they only exist as live object state. Stamping them by hand is the only way to make an existing, unmanaged CRD adoptable by a chart.
	- Run the stamp deliberately, by an operator, once. It is not a step Flux or any controller performs, and there is no automation for it in this repo.
- # Stamp ownership metadata onto folly's CRDs (live, one-time)
	- The ten CRDs `kube-prometheus-stack` currently owns unmanaged on folly:
	- ```text
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
	  ```
	- Confirm they are actually unmanaged before touching anything — this should print nothing for each:
	- ```bash
	  for crd in alertmanagerconfigs.monitoring.coreos.com alertmanagers.monitoring.coreos.com \
	    podmonitors.monitoring.coreos.com probes.monitoring.coreos.com \
	    prometheusagents.monitoring.coreos.com prometheuses.monitoring.coreos.com \
	    prometheusrules.monitoring.coreos.com scrapeconfigs.monitoring.coreos.com \
	    servicemonitors.monitoring.coreos.com thanosrulers.monitoring.coreos.com; do
	    kubectl --context folly get crd "$crd" \
	      -o jsonpath='{.metadata.labels.app\.kubernetes\.io/managed-by}{"\n"}'
	  done
	  ```
	- The three markers Helm's adoption check requires, applied to each CRD:
		- label `app.kubernetes.io/managed-by=Helm`
		- annotation `meta.helm.sh/release-name=prometheus-operator-crds`
		- annotation `meta.helm.sh/release-namespace=flux-system` — `flux-system`, not `monitoring`, because what the chart installs is cluster-scoped and the `monitoring` namespace is created by the Kustomization that runs after this one. Offsite uses the same namespace for the same reason; see `clusters/base/monitoring-crds/prometheus-operator-crds.yaml`.
	- Apply all three to all ten CRDs:
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
	    kubectl --context folly label crd "$crd" app.kubernetes.io/managed-by=Helm --overwrite
	    kubectl --context folly annotate crd "$crd" \
	      meta.helm.sh/release-name=prometheus-operator-crds \
	      meta.helm.sh/release-namespace=flux-system --overwrite
	  done
	  ```
	- Verify every CRD carries all three markers:
	- ```bash
	  for crd in "${CRDS[@]}"; do
	    kubectl --context folly get crd "$crd" -o jsonpath=\
	  '{.metadata.name} managed-by={.metadata.labels.app\.kubernetes\.io/managed-by} release={.metadata.annotations.meta\.helm\.sh/release-name} ns={.metadata.annotations.meta\.helm\.sh/release-namespace}{"\n"}'
	  done
	  ```
	- Each line should read `managed-by=Helm release=prometheus-operator-crds ns=flux-system`. Do not continue to the git-side change until all ten do.
- # Wire folly into monitoring-crds (git, only after the stamp succeeds)
	- Mirror `clusters/offsite/` exactly. Five changes:
	- Add a new clusters/folly/monitoring-crds/ directory:
	- ```text
	  clusters/folly/monitoring-crds/kustomization.yaml
	  ```
	- ```yaml
	  ---
	  apiVersion: kustomize.config.k8s.io/v1beta1
	  kind: Kustomization
	  resources:
	    - ../../base/monitoring-crds
	  ```
	- Add a new Flux Kustomization at:
	- ```text
	  clusters/folly/flux-system/monitoring-crds.yaml
	  ```
	- ```yaml
	  ---
	  apiVersion: kustomize.toolkit.fluxcd.io/v1
	  kind: Kustomization
	  metadata:
	    name: monitoring-crds
	    namespace: flux-system
	  spec:
	    interval: 1h0m0s
	    path: ./clusters/folly/monitoring-crds
	    prune: true
	    sourceRef:
	      kind: GitRepository
	      name: infra
	  ```
	- List it in `clusters/folly/flux-system/kustomization.yaml`'s `resources`, the way `clusters/offsite/flux-system/kustomization.yaml` lists `monitoring-crds.yaml`.
	- Add `monitoring-crds` to the `dependsOn` in `clusters/folly/flux-system/monitoring.yaml`, alongside the existing `storage` entry — matching the `dependsOn` shape already in `clusters/offsite/flux-system/monitoring.yaml`.
	- Set `crds.enabled` to `false` under `values:` in `clusters/folly/monitoring/kube-prometheus.yaml`, matching `clusters/offsite/monitoring/kube-prometheus.yaml`. Leaving it `true` makes the chart try to install CRDs it now owns by adoption rather than by its own `crds/` directory, on every upgrade — harmless once adopted, but redundant with the `monitoring-crds` Kustomization this wiring adds.
- # Order matters
	- The stamp must land on the live cluster before the git-side change merges. If the Kustomization and `dependsOn` wiring merge first, Flux installs the `prometheus-operator-crds` HelmRelease against CRDs that still lack ownership metadata, the install fails with "invalid ownership metadata", and `monitoring` stays blocked behind a Kustomization that never reaches Ready — the exact deadlock this procedure exists to avoid, now self-inflicted by wiring ahead of the stamp.
- # Verify after merge
	- ```bash
	  flux --context folly get kustomization monitoring-crds -n flux-system
	  flux --context folly get helmrelease prometheus-operator-crds -n flux-system
	  flux --context folly get kustomization monitoring -n flux-system
	  ```
	- All three should report `Ready`. If `monitoring-crds` is stuck, re-check the ten CRDs' ownership markers with the verify loop above before assuming a chart problem.
