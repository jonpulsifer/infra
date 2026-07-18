# terraform/pki — FML PKI & cluster OIDC issuers

Issues the per-cluster **FML K8s CAs** (pathLen:0) and **ServiceAccount token
signer** certs off the FML Intermediate CA (private key read from 1Password at
plan time). Each cluster's OIDC discovery documents live in `oidc/<cluster>/`
and are served at **https://oidc.lolwtf.ca/<cluster>** via Cloudflare Pages
(project/domain/DNS in `terraform/network/cloudflare/oidc.tf`, deployed by
`.github/workflows/oidc.yml`). See the FML PKI ADR in the wiki for the
architecture.

**This root requires OpenTofu** (`tofu`): it uses the `opentofu/tls` provider
fork for `max_path_length`, which is only published on the OpenTofu registry.
Atlantis runs OpenTofu server-wide (`ATLANTIS_DEFAULT_TF_DISTRIBUTION`).

Auth: the `onepassword` provider needs `OP_SERVICE_ACCOUNT_TOKEN` (Atlantis) or
a locally signed-in `op` CLI (`OP_ACCOUNT`). The service account must be able to
read the FML CA items in the `homelab` vault (UUIDs pinned in `pki.tf`).

## Rotation

Signer certs live 1 year (`early_renewal_hours` makes plans flag them ~30 days
out). To rotate: let Atlantis apply the replacement, then run
`scripts/pki/post-rotate.sh` — it sops-encrypts the new signer keys for the
control-plane hosts and regenerates `oidc/<cluster>/{jwks.json,openid-configuration.json}`
(committed here; the oidc workflow deploys them to Pages on merge). Deploy the
control planes per the Kubernetes GitOps runbook.

<!-- BEGIN_TF_DOCS -->
<!-- END_TF_DOCS -->
