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
- ## Vault
	- HashiCorp Vault runs in the folly cluster; auth methods, mounts, and policies are Terraform-managed in `terraform/vault/`. external-secrets syncs selected material into cluster secrets.
- ## PKI: offline root, online intermediate
	- The root CA was generated in an offline ceremony (`pki/offline-root-ceremony.sh`) anchored to a YubiKey with the key material sharded via SLIP-0039. Vault holds and operates the intermediate as the active issuing CA. See [[ADR/0007 Offline root CA with YubiKey and SLIP-0039]].
	- Ceremony artifacts under `pki/export/` are gitignored — CA keys and certs never get committed.
- ## 1Password
	- Operator credentials (UniFi, etc.) live in 1Password; the `op` CLI fetches them for tooling (e.g. the `unifi-network` skill). CI uses scoped service-account tokens where needed.
