# pki

OpenTofu root that issues each cluster's FML Kubernetes CA and ServiceAccount token signer from the FML intermediate CA, whose key it reads from 1Password. See [PKI](https://wiki.lolwtf.ca/platform/pki/) on the wiki.

This root needs OpenTofu, because only the OpenTofu registry publishes the `opentofu/tls` provider fork that sets `max_path_length`.

- `certs/` holds the public certificates. `<cluster>-ca-bundle.pem` is the current and previous CA, for `caFile`. `<cluster>-ca-chain.pem` is the CA up to the FML root, for `--root-ca-file`.
- `oidc/<cluster>/` holds each cluster's OIDC discovery documents, served at `https://oidc.lolwtf.ca/<cluster>`.
- `apps/fml-pki/` is the Go tool that handles the certificates and derives the OIDC documents.
- `scripts/pki/` holds the post-apply and trust-anchor scripts.

## Rules

- Never put the chain file in `caFile`. That option also backs `clientCaFile`, so the API server would accept any certificate issued under the FML root. `nix/services/k8s/default.nix` wires both files.
- `max_path_length = 0` on the cluster CAs has no effect, and the issued certificates carry no path length constraint.
- `prevent_destroy` guards each CA key's 1Password escrow item. Before you rotate a CA, move the old item to a versioned resource and title.

## Develop

```bash
tofu -chdir=terraform/pki init -backend=false
tofu -chdir=terraform/pki validate
TF_DIR=terraform/pki mise run tf:plan
mise run pki:verify
```

`mise run pki:verify` checks the chain, signatures and path lengths in `certs/` and needs no secrets. A local plan needs Google credentials for the state bucket and `OP_SERVICE_ACCOUNT_TOKEN` for a 1Password service account that can read the FML CA items in the `homelab` vault. `mise run tf:docs` regenerates the tables below.

## Deploy

Atlantis plans this root on a pull request that changes it. Comment `atlantis apply` to apply the plan, and a successful apply merges the pull request. State is in `gs://homelab-ng/terraform/pki`.

After an apply that issues a CA or a signer, run `scripts/pki/post-rotate.sh <cluster>` and commit what it writes. It updates `certs/`, the encrypted keys in `nix/secrets/`, `oidc/<cluster>/` and `clusters/offsite/apps/spindrift/ca-bundle.yaml`. `.github/workflows/oidc.yml` publishes the OIDC documents on merge.

<!-- BEGIN_TF_DOCS -->
<!-- END_TF_DOCS -->
