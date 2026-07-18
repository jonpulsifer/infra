status:: superseded
date:: 2026-07-06 (backfilled 2026-07-08)
deciders:: [[jawn]]
tags:: adr

- # Context
	- The homelab needs an internal PKI (mTLS, internal services), but an online root CA key — even in Vault — makes the cluster a single compromise away from total trust failure. Vault itself gets rebuilt/restored often enough that it shouldn't hold the root.
- # Decision
	- Generate the root CA in an **offline ceremony** (`pki/offline-root-ceremony.sh`): the root key is anchored to a **YubiKey**, with backup material sharded via **SLIP-0039** shares.
	- **Vault operates only the intermediate**, imported as the active issuing CA (`terraform/vault/` manages the mounts/policies).
- # Consequences
	- Compromise of the cluster or Vault caps out at the intermediate; revoke-and-reissue does not require re-rooting every trust store.
	- Issuing day-to-day certs is unchanged (Vault does it); only intermediate rotation requires a ceremony with the YubiKey.
	- Ceremony artifacts under `pki/export/` are **gitignored** — keys and certs never land in the repo.
	- Recovery depends on physical custody of the YubiKey and enough SLIP-0039 shares; losing both is unrecoverable by design.
- # Links
	- [[Architecture/Secrets and PKI]]
	- Superseded by [[ADR/0012 Migrate Vault to OpenBao]]
