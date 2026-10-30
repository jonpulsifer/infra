# pki

OpenTofu root that issues each cluster's FML Kubernetes CA and ServiceAccount token signer, and folly's DevID CAs, software and hardware, from the FML intermediate CA, whose key it reads from 1Password. See [PKI](https://wiki.lolwtf.ca/platform/pki/) on the wiki.

This root needs OpenTofu, because only the OpenTofu registry publishes the `opentofu/tls` provider fork that sets `max_path_length`.

- `certs/` holds the public certificates. `<cluster>-ca-bundle.pem` is the current and previous CA, for `caFile`. `<cluster>-ca-chain.pem` is the CA up to the FML root, for `--root-ca-file`. `folly-devid-ca-<name>.pem` is one issuing DevID CA alone, the file SPIRE's `devid.caChains` lists. `folly-devid-ca-<name>-chain.pem` is that CA up to the FML root, for talos-attest. `folly-devid-ca.pem` bundles every issuing DevID CA.
- `csr/` holds the CSR of each hardware DevID CA, whose key a YubiKey on an anchor generated. Each CSR gets a 5-year CA certificate, `certs/folly-devid-ca-<host>.pem`.
- `oidc/<cluster>/` holds each cluster's OIDC discovery documents, served at `https://oidc.lolwtf.ca/<cluster>`.
- `apps/fml-pki/` is the Go tool that handles the certificates and derives the OIDC documents.
- `scripts/pki/` holds the post-apply and trust-anchor scripts.

## Rules

- Never trust the FML root as a Kubernetes client CA. The API server would accept any certificate issued under it. Talos clusters use their own CA.
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

After an apply that issues a signer, run `scripts/pki/post-rotate.sh offsite` and commit what it writes. It updates the signer certificates in `certs/` and `oidc/<cluster>/`. Both clusters run the self-signed Kubernetes CA from their Talos secrets bundle, so no cluster CA file is committed. `.github/workflows/oidc.yml` publishes the OIDC documents on merge.

After an apply that issues or replaces the software DevID CA, run `SOPS_AGE_KEY_FILE=~/.config/age/keys.txt scripts/pki/devid-ca.sh` and commit what it writes: `folly-devid-ca-software.pem`, `folly-devid-ca-software-chain.pem`, the bundle `folly-devid-ca.pem`, and `talos-attest/devid-ca-key` in each anchor's `nix/secrets/<anchor>.sops.yaml`. `mise run pki:verify` checks each DevID CA, its chain file and the bundle.

A pull request that adds only a hardware CA's CSR changes no `.tf` file, so Atlantis does not autoplan it. Comment `atlantis plan -d terraform/pki` first. After the apply, `mise run devid:yubikey:install <host>` writes the certificate and the bundle to `certs/`. [Make a YubiKey a DevID CA](https://wiki.lolwtf.ca/runbooks/set-up-a-devid-ca-yubikey/) has every step.

<!-- BEGIN_TF_DOCS -->
<!-- END_TF_DOCS -->
