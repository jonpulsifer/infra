---
title: Secrets
description: Where secrets are stored, what decrypts them, and how they reach hosts and workloads.
---

Hosts and workloads get secrets from SOPS files in git, the `homelab` 1Password vault and GCP Secret Manager.

## Parts

| Part | Job | Where it runs |
| --- | --- | --- |
| SOPS | Encrypts the values in `*.sops.yaml` files | Your machine |
| Flux | Decrypts `clusters/**/*.sops.yaml` when it applies them | Each cluster |
| sops-nix | Decrypts `nix/secrets/<host>.sops.yaml` at activation | NixOS hosts |
| 1Password | Holds long-lived secrets and recovery copies | The `homelab` vault |
| External Secrets Operator (ESO) | Copies values from a store into Kubernetes Secrets | Each cluster |
| [OpenBao](#openbao) | A secrets server with no consumers | folly |

## Keys and recipients

SOPS encrypts with age, a file-encryption tool. An age recipient is a public key that SOPS encrypts a file to, and the matching private key decrypts the file.

- Every SOPS file lists the operator key, the owner's age key. Its private half is in `~/.config/age/keys.txt` and the 1Password item `sops homelab age key`.
- Flux reads the operator key from the Secret `sops-age` in `flux-system`. Git does not declare that Secret.
- A host recipient is the age key that `ssh-to-age` derives from the SSH host key. `nix/system/sops.nix` makes sops-nix decrypt with that key, so a host reads only the files encrypted to it.
- `nix/secrets/bosun.sops.yaml` is shared by riptide and oldschool. No host configuration reads it.
- In `clusters/`, SOPS encrypts only `data` and `stringData`.

## Stores

Both clusters have three ESO ClusterSecretStores.

| Store | Reads from | Authenticates with |
| --- | --- | --- |
| `onepassword-connect` | The `homelab` vault, through 1Password Connect | A Connect token from a SOPS file |
| `gcp-secret-manager` | kthx App config in Secret Manager in `bluenose` | [Workload identity](pki.md#workload-identity) |
| `spindrift-datastores` | The credentials of kthx Datastores | A ServiceAccount that reads Secrets in `spindrift-datastores` |

## OpenBao

Git declares no auth method, mount, policy or client for OpenBao. Flux deploys the HelmRelease `vault` from `clusters/folly/apps/vault/`. The release runs one pod, `vault-openbao-0`, with Raft storage and a UI at `https://vault.lolwtf.ca/ui/`.

A sealed OpenBao cannot read its storage. The pod unseals itself with the GCP KMS key `openbao` through workload identity. If `oidc.lolwtf.ca` or the folly token signer fails, a restarted pod stays sealed.

## Rules

- Keep a recovery copy of each host secret in a `homelab` item titled `<host> <thing>`. If the operator key and the host key are lost, SOPS cannot decrypt the file.
- A workload that reads the `onepassword-connect` store uses the vault item as its live value. An edit reaches the Secret within an hour.
- Declare no secret from a new host file before the file lists the host recipient, or the deploy fails.
- Replace the operator key in `.sops.yaml`, every SOPS file, both `sops-age` Secrets and 1Password, or Flux cannot decrypt.

## Where it lives

- `.sops.yaml`: the recipients for each path
- `nix/secrets/`: the host SOPS files
- `clusters/base/platform/`: ESO, 1Password Connect and the stores
- `terraform/gcp/projects/homelab-ng/kms.tf`: the OpenBao unseal key

## Related

- [Manage SOPS secrets](../runbooks/manage-sops-secrets.md)
- [Initialize OpenBao](../runbooks/initialize-openbao.md)
- [PKI](pki.md)
