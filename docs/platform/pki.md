---
title: PKI
description: The FML certificate chain, the Kubernetes cluster CAs and token signers, the cluster OIDC issuers and workload identity federation.
---

The FML (Folly Mountain Laboratories) PKI (public key infrastructure) is the private certificate chain of the lab. It signs a Kubernetes CA and a ServiceAccount token signer for each cluster. The signers make each cluster an OIDC issuer, which publishes the keys that other systems use to check its ServiceAccount tokens. With the issuers, workloads get GCP credentials and reach the other cluster with no stored key.

## Parts

| Part | Job | Where it runs |
| --- | --- | --- |
| cfssl | Issues node certificates and the break-glass `system:masters` certificate | Each control plane |
| API server | Signs ServiceAccount tokens as the issuer `https://oidc.lolwtf.ca/<cluster>` | Each control plane |
| OIDC documents | Publish the public keys of each signer | Cloudflare Pages, from `terraform/pki/oidc/<cluster>/` |
| `fml-pool` | Exchanges a ServiceAccount token for a GCP credential | GCP |

## Chain

| Certificate | Signed by | Private key |
| --- | --- | --- |
| FML Root CA | Itself | Offline. 1Password holds the certificate only. |
| FML Intermediate CA | FML Root CA | 1Password |
| FML K8s `<cluster>` CA | FML Intermediate CA | SOPS file of the control plane, and an escrow item in 1Password |
| `<cluster>` ServiceAccount token signer | FML K8s `<cluster>` CA | SOPS file of the control plane |

`terraform/pki` issues the cluster CAs and signers, and its state holds every private key it generates or reads. The root and intermediate do not expire. Cluster CAs last two years, and signers one year. The intermediate allows one CA below it, so a CA that a cluster CA signs fails validation.

Nodes trust `terraform/pki/certs/<cluster>-ca-bundle.pem`. Pods get `<cluster>-ca-chain.pem` as `ca.crt`. `apps/fml-pki` checks the chain with `mise run pki:verify` and writes the OIDC documents. The other `apps/fml-*` directories hold an offline root ceremony. No real ceremony transcript is committed.

## Workload identity

`fml-pool` has one provider for each cluster issuer.

| Workload | Cluster | Gets |
| --- | --- | --- |
| OpenBao | folly | The KMS key that unseals it |
| ESO store `gcp-secret-manager` | Both | Secret Manager in `bluenose` |
| Prowler | offsite | Read access to the GCP organization |
| kthx | offsite | See [Ownership and security](../apps/kthx/security.md#federation) |

Each API server also accepts tokens from the other cluster, for the ServiceAccounts `atlantis/atlantis` and `spindrift/spindrift` only. RBAC in `clusters/` binds them as `federated:<subject>`.

## Rules

- Keep `<cluster>-ca-chain.pem` out of `services.kubernetes.caFile`. That option also sets the client CA, so the API server would accept every client certificate under the FML Root.
- After Atlantis applies a new CA or signer, follow the rotation steps in `terraform/pki/README.md`. After a same-key reissue, cfssl and kube-controller-manager keep the old certificate until they restart.
- For a key change, follow the overlap and escrow steps in `terraform/pki/README.md`. `prevent_destroy` on the escrow item blocks a replacement.

## Where it lives

- `terraform/pki/`: the certificates, the OIDC documents and the rotation procedure in `README.md`
- `nix/services/k8s/default.nix`: the issuer, cfssl and the rule for tokens from the other cluster
- `terraform/gcp/projects/homelab-ng/workload-identity.tf`: `fml-pool`

## Related

- [Secrets](secrets.md)
- [Get cluster admin access](../runbooks/get-cluster-admin-access.md)
