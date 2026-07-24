tags:: runbook, kubernetes, gitops

- Use this when changing manifests under `clusters/` or inspecting Flux deployment state. Architecture lives in [[Architecture/Kubernetes]]; the apply model is on [[Architecture/GitOps]].
- # Rule
	- Author desired state in git and let Flux reconcile it after merge. Do not use `kubectl apply` to author state.
	- Use explicit contexts:
	- ```bash
	  kubectl --context folly get nodes
	  kubectl --context offsite get nodes
	  ```
- # Inspect reconciliation
	- ```bash
	  flux --context folly get kustomizations -A
	  flux --context folly get helmreleases -A
	  flux --context offsite get kustomizations -A
	  flux --context offsite get helmreleases -A
	  ```
	- For a specific object:
	- ```bash
	  kubectl --context <cluster> -n <namespace> describe <kind> <name>
	  kubectl --context <cluster> -n <namespace> get events --sort-by=.lastTimestamp
	  ```
- # Force a reconcile
	- Use this for inspection or to speed up a merged change:
	- ```bash
	  flux --context <cluster> reconcile kustomization <name> -n flux-system --with-source
	  ```
	- If a HelmRelease is stuck after its source reconciles:
	- ```bash
	  flux --context <cluster> reconcile helmrelease <name> -n <namespace>
	  ```
- # SOPS secrets
	- SOPS-encrypted files match `clusters/**/*.sops.yaml`; only encrypted `data` and `stringData` belong there.
	- Edit with SOPS:
	- ```bash
	  sops clusters/<cluster>/<path>/<secret>.sops.yaml
	  ```
	- Encrypt a new matching file:
	- ```bash
	  sops -e -i clusters/<cluster>/<path>/<secret>.sops.yaml
	  ```
	- Never paste decrypted values into this wiki, issues, PR comments, or logs.
- # HelmRelease source pattern
	- Keep `HelmRepository`, `GitRepository`, or `OCIRepository` sources colocated with the resource that consumes them.
	- Do not centralize sources unless the local pattern changes across the repo.
- # Atlantis and ArgoCD auth
	- Atlantis runs in offsite and may need to authenticate to ArgoCD in folly for Terraform/Argo checks.
	- Symptom of an expired or rotated ArgoCD token:
		- GitHub PR status for Atlantis plan fails.
		- Atlantis logs show authentication or signature errors talking to ArgoCD.
	- Rotation shape:
		- Generate a fresh token for the Atlantis ArgoCD account using an authenticated ArgoCD admin path.
		- Store it only in the SOPS-encrypted Atlantis secret.
		- Reconcile or wait for Flux to deploy the updated secret.
		- Re-run the Atlantis plan.
	- Do not record generated tokens or admin credentials in plaintext.
- # Validate before PR
	- Build the kustomization root that includes the change:
	- ```bash
	  kubectl kustomize clusters/<cluster>/<category>
	  ```
	- For shared `clusters/base/` changes, validate both clusters. See [[Runbooks/Add Shared Kubernetes Resource]].
