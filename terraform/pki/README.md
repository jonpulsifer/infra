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

## Export and rotation

Cluster CAs expire in July 2028. Their shorter lifetime is intentional: the
fleet exercises overlapping CA rotation rather than treating its trust roots as
permanent. Signer certs live 1 year (`early_renewal_hours` makes plans flag them
about 30 days out).

After Atlantis applies a CA or signer replacement, run
`scripts/pki/post-rotate.sh <cluster>`. It writes public certificates under
`certs/`, SOPS-encrypts each cluster CA and signer private key for the matching
control-plane host, and regenerates
`oidc/<cluster>/{jwks.json,openid-configuration.json}`. Commit those outputs
before deploying the control planes. The OIDC workflow publishes the discovery
documents on merge. The helper verifies that each private key matches its
certificate and prints the certificate expiry inventory.

Terraform also escrows each long-lived cluster CA key to a write-only
1Password item in the `homelab` vault. SOPS is the deployment copy; 1Password
is the operator recovery copy. Terraform prevents destroying an escrow item:
before rotating a CA, preserve the old item under a versioned resource and
title so rollback remains available for the full overlap window.

ServiceAccount signer overlap and Kubernetes TLS CA overlap are separate
rotation concerns: JWKS retains the previous signer while its tokens remain
valid. On CA replacement, the helper moves the current certificate to
`certs/<cluster>-ca-prev.pem` and builds
`certs/<cluster>-ca-bundle.pem` with new and previous CAs. Stage that bundle on
every Kubernetes client and server, reissue all TLS leaves from the new CA, and
verify the fleet before deleting `*-ca-prev.pem` and rerunning the helper.
Rollback restores the prior git revision (including its SOPS ciphertext), then
redeploys the overlap bundle and rebuilds the affected hosts.

<!-- BEGIN_TF_DOCS -->
<!-- END_TF_DOCS -->
