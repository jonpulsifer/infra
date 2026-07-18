icon:: 🔐
tags:: architecture

- Secrets never land in git in plaintext, and this wiki is public — nothing decrypted belongs here, ever.
- ## SOPS + age (Kubernetes secrets)
	- SOPS encrypts the `data`/`stringData` fields of any file matching `clusters/.*\.sops\.ya?ml` (path regex in `.sops.yaml`). The age key must be available to edit.
	- ```bash
	  sops clusters/folly/config/cluster-secrets.sops.yaml   # edit
	  sops -d clusters/folly/networking/tailscale/secret.sops.yaml   # inspect
	  sops -e -i clusters/<cluster>/<path>.sops.yaml   # encrypt new file
	  ```
	- Flux decrypts at reconcile time in-cluster.
- ## OpenBao
	- OpenBao runs in the folly cluster with isolated Raft storage and GCP KMS auto-unseal. It starts with no migrated Vault data or PKI material; configure any future auth methods, mounts, policies, and PKI explicitly.
- ## 1Password
	- Operator credentials (UniFi, etc.) live in 1Password; the `op` CLI fetches them for tooling (e.g. the `unifi-network` skill). CI uses scoped service-account tokens where needed.
