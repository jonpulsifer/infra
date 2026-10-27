---
title: PKI
description: The FML certificate chain, the Kubernetes cluster CAs and token signers, the cluster OIDC issuers and workload identity federation.
---

The FML (Folly Mountain Laboratories) PKI (public key infrastructure) is the private certificate chain of the lab. It signs a ServiceAccount token signer for each cluster. The signers make each cluster an OIDC issuer, which publishes the keys that other systems use to check its ServiceAccount tokens. With the issuers, workloads get GCP credentials and reach the other cluster with no stored key.

## Parts

| Part | Job | Where it runs |
| --- | --- | --- |
| API server | Signs ServiceAccount tokens as the issuer `https://oidc.lolwtf.ca/<cluster>` | Each control plane |
| OIDC documents | Publish the public keys of each signer | Cloudflare Pages, from `terraform/pki/oidc/<cluster>/` |
| `fml-pool` | Exchanges a ServiceAccount token for a GCP credential | GCP |

## Chain

| Certificate | Signed by | Private key |
| --- | --- | --- |
| FML Root CA | Itself | Offline. 1Password holds the certificate only. |
| FML Intermediate CA | FML Root CA | 1Password |
| Kubernetes CA of `<cluster>` | Itself | The Talos secrets bundle, the 1Password item `talos-<cluster>-secrets` |
| `<cluster>` ServiceAccount token signer | FML K8s `<cluster>` CA | The Talos secrets bundle, imported from the signer key |

`terraform/pki` issues the signers, and its state holds every private key it generates or reads. The root and intermediate do not expire. Signers last one year. The intermediate allows one CA below it, so a CA that a signer's issuer signs fails validation.

Both clusters run the self-signed Kubernetes CA from their secrets bundle, so nodes and pods trust that CA and no cluster CA file is committed under `terraform/pki/certs/`. `apps/fml-pki` checks the chain with `mise run pki:verify` and writes the OIDC documents. The other `apps/fml-*` directories hold an offline root ceremony. No real ceremony transcript is committed.

## Workload identity

`fml-pool` has one provider for each cluster issuer. Its provider `spire` takes SPIRE JWT-SVIDs, as [Identity](identity.md#gcp-access) says.

| Workload | Cluster | Gets |
| --- | --- | --- |
| OpenBao | folly | The KMS key that unseals it |
| ESO store `gcp-secret-manager` | Both | Secret Manager in `bluenose` |
| Prowler | offsite | Read access to the GCP organization |
| kthx | offsite | See [Ownership and security](../apps/kthx/security.md#federation) |
| mate database backup | offsite | Write access to the `homelab-ng-mate` bucket. See [How Rowbutt works](../apps/mate/how-it-works.md#session-store). |
| `backups:backup-push` | Both | Access to the `homelab-ng-backups-<site>` bucket of its site. See [Backups](backups.md). |

Each API server also accepts tokens from the other cluster, for the ServiceAccounts `atlantis/atlantis`, `mate/mate-sandbox-admin`, `mate/mate-sandbox-reader` and `spindrift/spindrift` only. RBAC in `clusters/` binds them as `federated:<subject>`.

## Talos Secure Boot keys

folly's signed Talos images use the lab's own Secure Boot keys, outside the FML chain. The 1Password item `talos-secureboot` in the `homelab` vault holds every key. `clusters/folly/talos/secureboot/` holds the public halves. [Kubernetes](kubernetes.md#signed-talos-images) says what the build makes with them.

| Key | Signs | Public half in git |
| --- | --- | --- |
| UKI signing key, `FML Secure Boot` | Each UKI, systemd-boot and the netboot iPXE. The firmware boots them because `db` holds its certificate. | `uki-signing-cert.pem`, `uki-signing-cert.der` |
| HookOS signing key, `FML HookOS Secure Boot` | The HookOS UKI. PCR 7 records which `db` certificate verified a boot, so a HookOS boot never measures Talos's PCR 7. | `hookos-signing-cert.pem`, `hookos-signing-cert.der` |
| PCR signing key | The expected PCR 11 value of each UKI. A TPM opens a sealed disk only under a policy this key signed. | None |
| `PK`, `KEK` and `db` | The firmware's key lists. A machine in Setup Mode enrolls them. `db` holds both lab certificates and the Microsoft UEFI certificates. The UKI signing key signs all three. | `PK.auth`, `KEK.auth`, `db.auth` |

The UKI and HookOS signing keys are RSA-2048. HP's EliteDesk 800 G2 and G5 firmware refused images signed with RSA-4096 keys whose certificates were in `db`. The item's `PK_auth`, `KEK_auth` and `db_auth` files match the committed `.auth` files. The PCR signing key is fleet-wide. Every disk that a TPM seals to the signed policy is bound to it, so a new key leaves each sealed disk unable to open after the next upgrade. Rotate it only with a plan that reinstalls each such node.

## Rules

- Never trust the FML Root as a client CA of a cluster, or its API server would accept every client certificate under the FML Root.
- After Atlantis applies a new signer, follow the rotation steps in `terraform/pki/README.md`.
- For a key change, follow the overlap and escrow steps in `terraform/pki/README.md`. `prevent_destroy` on the escrow item blocks a replacement.
- On a Talos cluster, a talosconfig's client certificate lasts one year, and the Talos API cannot revoke it. Issue the owner's and Rowbutt's again before they expire, as [Issue a talosconfig](../runbooks/issue-a-talosconfig.md) says. Only `talosctl rotate-ca` withdraws a lost one.

## Where it lives

- `terraform/pki/`: the certificates, the OIDC documents and the rotation procedure in `README.md`
- `clusters/<site>/talos/patches.tf`: the issuer and the rule for tokens from the other cluster
- `terraform/gcp/projects/homelab-ng/workload-identity.tf`: `fml-pool`
- `clusters/folly/talos/secureboot/`: the public halves of the Talos Secure Boot keys

## Related

- [Secrets](secrets.md)
- [Get cluster admin access](../runbooks/get-cluster-admin-access.md)
