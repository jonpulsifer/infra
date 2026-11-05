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
| [OpenBao](#openbao) | The lab's online CA and secrets server, sealed by a YubiKey | forge |
| OpenBao on folly | A secrets server with no consumers, unsealed by GCP KMS | folly |

## Keys and recipients

SOPS encrypts with age, a file-encryption tool. An age recipient is a public key that SOPS encrypts a file to, and the matching private key decrypts the file.

- Every SOPS file lists the operator key, the owner's age key. Its private half is in `~/.config/age/keys.txt` and the 1Password item `sops homelab age key`.
- Flux reads the operator key from the Secret `sops-age` in `flux-system`. Git does not declare that Secret.
- A host recipient is the age key that `ssh-to-age` derives from the SSH host key. `nix/system/sops.nix` makes sops-nix decrypt with that key, so a host reads only the files encrypted to it.
- `nix/secrets/bosun.sops.yaml` has oldschool, a Talos node, as its host recipient. No host configuration reads it.
- In `clusters/`, SOPS encrypts only `data` and `stringData`.

## Stores

Both clusters have three ESO ClusterSecretStores.

| Store | Reads from | Authenticates with |
| --- | --- | --- |
| `onepassword-connect` | The `homelab` vault, through 1Password Connect | A Connect token from a SOPS file |
| `gcp-secret-manager` | kthx App config in Secret Manager in `bluenose` | [Workload identity](pki.md#workload-identity) |
| `kthx-datastores` | The credentials of kthx Datastores | A ServiceAccount that reads Secrets in `kthx-datastores` |

## OpenBao

OpenBao on [forge](../hosts/forge.md) is the server that holds every CA of the lab below the FML root, as [PKI](pki.md) says, and the secrets a host or workload fetches at runtime. `nix/services/openbao.nix` runs it with Raft storage in `/var/lib/openbao`, a UI and API at `https://forge.lolwtf.ca:8200`, and a Let's Encrypt certificate from the Cloudflare DNS-01 challenge, since kubelets, cert-manager and browsers trust only public roots. `homelab.openbao` in `nix/hosts/forge.nix` turns it on.

A sealed OpenBao cannot read its storage. The server unseals itself through the `pkcs11` seal with an RSA key in slot 9d of the YubiKey in forge's USB port (`nix/services/yubikey-piv.nix`), so a restart needs no cloud, no cluster and no person. `scripts/openbao-yubikey.sh` imports the key into the card from the 1Password item `openbao-unseal-key`, where it is escrowed so that every Raft voter can carry it. The recovery keys from `bao operator init` are in the 1Password item `openbao-forge`. [Initialize OpenBao](../runbooks/initialize-openbao.md) has the first start.

The API is open to the Anchor network, folly's nodes and pods, and the tailnet. Prometheus on folly scrapes `/v1/sys/metrics` with no token, and `clusters/folly/monitoring/forge.yaml` alerts when the unit is down or the server is sealed.

A second OpenBao runs on folly with no consumers. Flux deploys the HelmRelease `vault` from `clusters/folly/apps/vault/`, one pod with Raft storage and a UI at `https://vault.lolwtf.ca/ui/`. It unseals itself with the GCP KMS key `openbao` through workload identity, so a restarted pod stays sealed while `oidc.lolwtf.ca` or the folly token signer fails. Velero copies its volume each night, best effort. It goes once forge's server has taken its role.

## Rules

- Keep a recovery copy of each host secret in a `homelab` item titled `<host> <thing>`. If the operator key and the host key are lost, SOPS cannot decrypt the file.
- A workload that reads the `onepassword-connect` store uses the vault item as its live value. An edit reaches the Secret within an hour.
- Declare no secret from a new host file before the file lists the host recipient, or the deploy fails.
- Replace the operator key in `.sops.yaml`, every SOPS file, both `sops-age` Secrets and 1Password, or Flux cannot decrypt.

## Where it lives

- `.sops.yaml`: the recipients for each path
- `nix/secrets/`: the host SOPS files
- `clusters/base/platform/`: ESO, 1Password Connect and the stores
- `nix/services/openbao.nix`, `nix/services/yubikey-piv.nix` and `scripts/openbao-yubikey.sh`: OpenBao on forge and its unseal key
- `terraform/gcp/projects/homelab-ng/kms.tf`: the unseal key of OpenBao on folly

## Related

- [Manage SOPS secrets](../runbooks/manage-sops-secrets.md)
- [Initialize OpenBao](../runbooks/initialize-openbao.md)
- [PKI](pki.md)
