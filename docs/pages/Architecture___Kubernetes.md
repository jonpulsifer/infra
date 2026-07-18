icon:: ☸️
tags:: architecture

- **Layer 2.** Two clusters reconciled by FluxCD from `clusters/`, with ArgoCD layered on for apps sourced from external repositories.
- ## Clusters
	- `clusters/folly/` — primary on-site cluster (`optiplex`, `riptide`, `shale`)
	- `clusters/offsite/` — backup cluster (`retrofit`, `oldschool`)
	- `clusters/base/` — resources shared by both, referenced by path from each cluster (the multi-cluster pattern)
- ## Per-cluster structure
	- `flux-system/` — FluxCD source-of-truth kustomizations
	- `networking/` — Cilium, cert-manager, Cloudflare tunnel, Gateway API, external-dns
	- `monitoring/` — kube-prometheus-stack, Loki, Grafana, promtail (folly only; offsite has no Prometheus)
	- `nodes/` — Intel device plugins, node-feature-discovery
	- `storage/` — storage classes and provisioners
	- `config/` — cluster secrets and the `cluster-topology` ConfigMap ([[ADR/0003 Cluster topology single source of truth]])
	- `bootstrap/` — the Terraform that installs `flux-operator`/`flux-instance` and labels nodes
- ## How things deploy
	- Merge to `main` → Flux reconciles. **Never `kubectl apply`** to author state; `kubectl` and `flux` are for inspection or forcing a sync ([[ADR/0001 GitOps apply model]]).
	- ```bash
	  flux get kustomizations -A
	  flux reconcile kustomization <name> -n flux-system
	  ```
	- Use explicit contexts and namespaces: `--context folly` / `--context offsite`.
	- First-party apps deploy as Flux HelmReleases using the `app` / `ai-agent` charts from `packages/charts/`, referenced as `packages/charts/<name>` against the `infra` GitRepository.
	- Actions Runner Controller provides a shared `infra-<cluster>` scale set in each cluster. First-party repositories use that infra runner pool; they do not get repository-specific scale sets.
	- ArgoCD application definitions are Terraform-managed in `terraform/argo/`.
- ## Networking inside the clusters
	- Cilium is the CNI and the BGP load balancer; VIP pools live in `networking/cilium/ip-pools.yaml` — see [[Architecture/Networking]] and [[ADR/0005 Cilium BGP load balancing]].
	- Ingress is Gateway API: a `cluster-gateway` fronted by a Cloudflare Tunnel as the external entry point.
- ## Secrets
	- SOPS-encrypted in-repo (`clusters/**/*.sops.yaml`) — see [[Architecture/Secrets and PKI]].
