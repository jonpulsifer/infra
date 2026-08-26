icon:: 🧩
tags:: architecture

- What actually runs on the two Kubernetes clusters, and where its manifests live. Cluster mechanics are on [[Architecture/Kubernetes]]; first-party source and image builds are on [[Architecture/Applications]].
- The tree is the source of truth: each row names a directory under `clusters/`. If a row and the directory disagree, the directory wins.
- ## Shared — `clusters/base/apps/`
	- Referenced by relative path from each cluster's apps kustomization (e.g. `clusters/folly/apps/kustomization.yaml`), or wrapped by a thin per-cluster overlay that adds site secrets.
	- | Directory | What it is |
	  | --- | --- |
	  | `arc` | GitHub Actions runner scale sets (`gha-runner-scale-set`) running `ghcr.io/jonpulsifer/actions-runner`. Each cluster wraps it in `clusters/<site>/apps/arc/` with its own SOPS secret, driven by a dedicated `arc-runners` Flux Kustomization. |
	  | `descheduler` | Evicts pods that violate scheduling constraints after the fact. |
	  | `iperf3` | Throughput probe, built from `ghcr.io/jonpulsifer/netbench`. |
	  | `oauth2-proxy` | SSO gate in front of unauthenticated services. Each cluster wraps it in `clusters/<site>/apps/oauth2-proxy/` and gives it its own Flux Kustomization. |
	  | `reloader` | Restarts workloads when a mounted ConfigMap or Secret changes. |
	- Platform components that other apps depend on — CloudNativePG, external-secrets, Kyverno, the Valkey operator, the Spindrift target and policy sets — live in `clusters/base/platform/`, not `base/apps/`.
- ## folly — `clusters/folly/apps/`
	- The on-site cluster: media, lab, and household services alongside the AI and load-testing surfaces.
	- | Directory | What it is |
	  | --- | --- |
	  | `argo` | ArgoCD, installed as a HelmRelease. Owns no applications — Flux does the reconciling. |
	  | `default` | The `default` namespace odds and ends: `hajimari` (the homelab dashboard) and `podinfo`. |
	  | `descheduler` | Cluster-local descheduler release. |
	  | `dump.yaml` | Scratch nginx pod for poking at cluster networking. |
	  | `falco` | Runtime security monitoring. |
	  | `hermes` | Nous Research Hermes agent, deployed through the first-party `packages/charts/ai-agent` chart. |
	  | `jellyfin.yaml` | Media server. |
	  | `k6` | The k6 operator, plus the TestRun scaffolding for lab load tests. |
	  | `netbench` | First-party network benchmark image. |
	  | `open-webui` | Chat frontend for local models. |
	  | `pbx` | Asterisk PBX. |
	  | `postgres` | CloudNativePG cluster for folly workloads. |
	  | `redis` | Redis for folly workloads. |
	  | `satisfactory` | Game server. Commented out of `clusters/folly/apps/kustomization.yaml`, so nothing is reconciled today. |
	  | `spindrift-target` | The Gateway and RBAC that let Spindrift place workloads on folly. |
	  | `tronbyt` | `tronbyt-server` plus the `rackstat` aggregator that feeds the Tidbyt display. |
	  | `vault` | OpenBao. |
- ## offsite — `clusters/offsite/apps/`
	- The remote-site cluster: everything public-facing or upload-heavy, because folly's WAN is asymmetric.
	- | Directory | What it is |
	  | --- | --- |
	  | `atlantis` | The Terraform apply path for every PR — see [[Architecture/GitOps]]. |
	  | `dave.yaml` | An `ai-agent` chart release in the `agents-sandbox` namespace. |
	  | `descheduler` | Cluster-local descheduler release. |
	  | `hub` | `apps/hub`, deployed through the first-party `packages/charts/app` chart. |
	  | `prowler` | Cloud security posture scanning, via `packages/charts/prowler`. |
	  | `spindrift` | The Spindrift control plane itself — [[Architecture/Spindrift]]. |
	  | `spindrift-target` | Pulled straight from `clusters/base/platform/spindrift-target`: namespace, RBAC, and network policy for Spindrift-owned workloads. |
- ## Reading this yourself
	- The `kustomization.yaml` in each cluster's `apps/` directory (`clusters/folly/apps/`, `clusters/offsite/apps/`) is the authoritative list of what a cluster reconciles — a directory present on disk but absent from that file (or commented out) is not running.
	- `mise run k8s:render-apps` renders both clusters' trees locally if you want the resolved objects rather than the sources.
