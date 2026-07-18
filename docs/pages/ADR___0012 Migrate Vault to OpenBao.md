status:: accepted
date:: 2026-07-18
deciders:: [[jawn]]
supersedes:: [[ADR/0007 Offline root CA with YubiKey and SLIP-0039]]
tags:: adr, openbao, secrets

- # Context
	- Vault 1.21.2 used GCS storage and GCP KMS auto-unseal. OpenBao's supported in-place migration guide does not cover that Vault version, storage backend, or seal configuration.
	- The existing Vault state contains little material, and a fresh PKI will be deployed separately, so preserving Vault data and the existing intermediate is unnecessary.
- # Decision
	- Replace the Vault Helm chart with the official OpenBao chart while preserving the public `vault.lolwtf.ca` endpoint for clients.
	- Provision a distinct GCP KMS key and use OpenBao's integrated Raft storage. Do not point OpenBao at Vault's GCS storage.
	- Retire the repository-managed Vault Terraform root and offline-intermediate tooling. Bootstrap future OpenBao configuration and PKI as new, deliberate work.
	- Keep the old Vault backing resources through the initial OpenBao verification window so rollback remains possible.
- # Consequences
	- OpenBao starts empty and requires a manual `bao operator init` bootstrap after Flux deploys it.
	- Existing Vault secrets, tokens, auth configuration, and issued certificates are intentionally not migrated.
	- The old Vault GCS bucket and KMS key require a later, separate retirement PR after OpenBao is verified.
