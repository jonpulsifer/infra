tags:: runbook, openbao, secrets

- Use this once after the OpenBao HelmRelease has reconciled. The deployment uses integrated Raft storage and GCP KMS auto-unseal; it starts intentionally empty.
- # Preconditions
	- The Terraform change creating the `openbao` GCP KMS key has applied through Atlantis.
	- Flux reports the `vault` HelmRelease Ready in the `vault` namespace.
	- A 1Password vault is ready to hold the recovery keys and initial root token. Never put them in Git, a terminal recording, or this wiki.
- # Initialize
	- Confirm the pod is running and uninitialized:
	- ```bash
	  kubectl --context folly -n vault get pods -l app.kubernetes.io/name=openbao
	  kubectl --context folly -n vault exec vault-openbao-0 -- bao status
	  ```
	- Initialize exactly once. Capture the output directly into the approved secret store without pasting it into a shell history or chat:
	- ```bash
	  kubectl --context folly -n vault exec -it vault-openbao-0 -- bao operator init
	  ```
	- Verify the instance is initialized and unsealed:
	- ```bash
	  kubectl --context folly -n vault exec vault-openbao-0 -- bao status
	  ```
- # Verify
	- Open `https://vault.lolwtf.ca/ui/` and authenticate with the initial root token only long enough to establish the intended administrator and policies.
	- Confirm a pod restart auto-unseals through GCP KMS before storing production material.
	- Create required auth methods, mounts, policies, audit devices, and the fresh PKI through a reviewed follow-up change.
- # Rollback
	- Before new production data is written, restore the previous HelmRelease chart and GCP KMS/storage configuration from Git, then reconcile Flux.
	- Do not remove the old Vault GCS bucket or KMS key until OpenBao has been verified for the agreed retention window.
