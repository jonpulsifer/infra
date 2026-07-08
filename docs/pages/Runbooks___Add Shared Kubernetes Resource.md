tags:: runbook, kubernetes, gitops

- Use this when adding or changing resources shared by both clusters through `clusters/base/`. General GitOps flow is in [[Runbooks/Kubernetes GitOps Change]].
- # Pattern
	- Shared resources live under `clusters/base/`.
	- Each shared component should be a directory with its own `kustomization.yaml`.
	- Cluster overlays reference the shared directory, not individual files.
- # Add a shared component
	- Create a directory:
	- ```text
	  clusters/base/<category>/<component>/
	  ```
	- Add a `kustomization.yaml` that lists the component's resource files:
	- ```yaml
	  apiVersion: kustomize.config.k8s.io/v1beta1
	  kind: Kustomization
	  resources:
	    - resource.yaml
	  ```
	- Templatize cluster-specific values with Flux substitutions such as `${CLUSTER_NAME}` or `${SECRET_DOMAIN}` when the parent Flux Kustomization provides them.
	- Reference the shared directory from each cluster overlay:
	- ```yaml
	  resources:
	    - ../../../base/<category>/<component>
	  ```
	- Add cluster-specific patches in the overlay only when the clusters genuinely differ.
- # Constraints
	- Kustomize cannot reference individual files outside the kustomization root. Always reference a directory with its own `kustomization.yaml`.
	- Flux `postBuild.substituteFrom` performs variable replacement at deploy time.
	- Variables generally come from the cluster topology/config ConfigMaps and SOPS-encrypted cluster secrets.
- # Usually cluster-specific
	- `cilium/` BGP peers, IP pools, and Hubble settings.
	- Gateway listeners and routes.
	- Tailscale connector names, routes, and tags.
	- Cloudflare tunnel credentials.
	- Some cert-manager issuers and certificates.
- # Validate
	- Build each consuming cluster overlay:
	- ```bash
	  kubectl kustomize clusters/folly/<category>
	  kubectl kustomize clusters/offsite/<category>
	  ```
	- If only one cluster consumes the base path today, validate that cluster and note the asymmetry in the PR.
