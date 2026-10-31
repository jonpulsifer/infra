---
title: PKI
description: The FML certificate chain, the Kubernetes cluster CAs and token signers, the cluster OIDC issuers, workload identity federation and the hardware DevID CAs.
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
| `FML DevID folly CA` | FML Intermediate CA | `terraform/pki` state; no service signs with it, and the bundle keeps the LDevIDs it issued trusted |
| `folly-devid-ca-<host>` | FML Intermediate CA | The YubiKey on the anchor `<host>` |
| A node's LDevID and LAK | A DevID CA | The node's TPM |

`terraform/pki` issues the signers and the DevID CAs, and its state holds every private key it generates or reads. The root and intermediate do not expire. Signers last one year, and the DevID CAs five years. The intermediate allows one CA below it, so a CA that a signer's issuer signs fails validation.

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

## DevID CAs

The DevID CAs sign each attested machine's LDevID and LAK certificates. Each one is a CA under the FML intermediate, which allows no further CA below it. Two of them are hardware CAs, one on a YubiKey in each of two anchors, so losing a key loses one CA, and its machines attest again under the other.

| CA | Key | Anchor |
| --- | --- | --- |
| `FML DevID folly CA` | ECDSA P-256, a software key in the `terraform/pki` state | Every anchor, from its sops file |
| `folly-devid-ca-spore` | RSA-2048, generated in PIV slot 9c of a YubiKey 5 | spore |
| `folly-devid-ca-capsule` | RSA-2048, generated in PIV slot 9c of a YubiKey 4c | capsule |

A key never leaves its card. Its PIN policy is once and its touch policy is never, so a service signs unattended after one login. The keys are RSA because YubiKey 5 firmware before 5.7 leaks ECDSA keys (Yubico's EUCLEAK advisory), and the 4c's firmware is past the ROCA fix in 4.3.5.

- `scripts/devid-ca-yubikey.sh` sets each card's PIN, PUK and management key, stores them in the host's SOPS file and the 1Password item `devid-ca-<host>`, and commits the key's CSR.
- `terraform/pki/devid.tf` issues the software CA. `scripts/pki/devid-ca.sh` writes it to `folly-devid-ca-software.pem` and its chain to `folly-devid-ca-software-chain.pem` in `terraform/pki/certs/`.
- `terraform/pki/devid-ca.tf` gives each committed CSR a 5-year CA certificate, `folly-devid-ca-<host>.pem` in the same directory.
- `folly-devid-ca.pem` in the same directory bundles every issuing DevID CA, for a verifier that takes one trust file. A `folly-devid-ca-<name>-chain.pem` beside a CA is its chain up to the FML root, and stays out of the bundle. spore's SPIRE server lists each CA file in `homelab.spire.devid.caChains`, as [Identity](identity.md) says.
- `mise run pki:verify` fails when the bundle misses a CA, or a CA or chain file does not chain to the FML intermediate.
- `nix/services/devid-ca-yubikey.nix` runs pcscd and the ykcs11 PKCS#11 module on an anchor that sets `homelab.devidCa.yubikey.enable`. Members of the `devid-ca` group, fleetd on spore, may use the card and read its PIN.
- `packages/pkcs11signer` is the Go `crypto.Signer` that signs on the card. It finds the key whose public key matches the CA certificate. [fleetd](../apps/fleetd.md) signs every LDevID with it on spore's YubiKey.

| Variable | Value |
| --- | --- |
| `ATTEST_CA_PKCS11_MODULE` | The ykcs11 module, `homelab.devidCa.yubikey.pkcs11Module` |
| `ATTEST_CA_PKCS11_TOKEN` | The token label, `YubiKey PIV #<serial>`, `homelab.devidCa.yubikey.tokenLabel` |
| `ATTEST_CA_PKCS11_PIN_FILE` | The PIN, `homelab.devidCa.yubikey.pinFile` |
| `ATTEST_CA_CERT` | A PEM file whose first certificate is the CA's |

Until `scripts/pki/devid-ca.sh` or the YubiKey runbook commits one, `terraform/pki/certs/` holds no DevID CA. [Make a YubiKey a DevID CA](../runbooks/set-up-a-devid-ca-yubikey.md) makes one.

## Rules

- Never trust the FML Root as a client CA of a cluster, or its API server would accept every client certificate under the FML Root.
- Read a DevID CSR before `atlantis apply`. The intermediate makes a CA of every CSR that `terraform/pki/devid-ca.tf` finds.
- After Atlantis applies a new signer, follow the rotation steps in `terraform/pki/README.md`.
- After Atlantis applies or replaces the DevID CA, run `scripts/pki/devid-ca.sh` and commit what it writes. A new CA leaves every LDevID untrusted until its node attests again.
- For a key change, follow the overlap and escrow steps in `terraform/pki/README.md`. `prevent_destroy` on the escrow item blocks a replacement.
- On a Talos cluster, a talosconfig's client certificate lasts one year, and the Talos API cannot revoke it. Issue the owner's and Rowbutt's again before they expire, as [Issue a talosconfig](../runbooks/issue-a-talosconfig.md) says. Only `talosctl rotate-ca` withdraws a lost one, and `--kubernetes=false` limits the rotation to the Talos API CA, which is all a talosconfig needs.
- On folly, rotate the Kubernetes CA only with a plan for the workers [fleetd](../apps/fleetd.md) installed, `fleet_workers` in `clusters/folly/talos/talos.tf`. Talos deletes a kubelet certificate that no accepted CA signed, and their kubelets then bootstrap with the token the Talos root gives them, which no Secret holds, so they stay off the cluster until [they install again](#rejoin-fleetds-workers-after-a-ca-rotation).

## Rejoin fleetd's workers after a CA rotation

A rotation of folly's Kubernetes CA leaves each worker in `fleet_workers` without a kubelet certificate and without a token that joins. Each one installs again through fleetd, which gives it a token of its own.

1. Commit the new CA to `clusters/folly/config/kubernetes-ca.pem`, and deploy spore from `main`, as [Deploy a NixOS host](../runbooks/deploy-a-nixos-host.md) describes. fleetd reaches folly's API with that CA.
2. For one worker at a time, follow [Reprovision a node](../runbooks/reprovision-a-node.md). The reinstall erases the node's local-path volumes, so restore them as that runbook says.

   Result: the node is `Ready` with a new kubelet certificate.

## Where it lives

- `terraform/pki/`: the certificates, the OIDC documents and the rotation procedure in `README.md`
- `clusters/<site>/talos/patches.tf`: the issuer and the rule for tokens from the other cluster
- `terraform/gcp/projects/homelab-ng/workload-identity.tf`: `fml-pool`
- `clusters/folly/talos/secureboot/`: the public halves of the Talos Secure Boot keys
- `terraform/pki/devid-ca.tf`, `scripts/devid-ca-yubikey.sh` and `nix/services/devid-ca-yubikey.nix`: the hardware DevID CAs

## Related

- [Secrets](secrets.md)
- [Get cluster admin access](../runbooks/get-cluster-admin-access.md)
