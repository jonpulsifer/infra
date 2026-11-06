# pki

The public half of the FML PKI, and the OIDC discovery documents of both clusters. It is not an OpenTofu root: the root and the issuing CA are inside OpenBao on forge, the DevID CAs are on YubiKeys, and the ServiceAccount token signers are keys in the Talos secrets bundles. See [PKI](https://wiki.lolwtf.ca/platform/pki/) on the wiki.

- `certs/` holds the public certificates. `fml-root.pem` and `folly-issuing-ca.pem` are the root and the issuing CA that OpenBao holds. `folly-devid-ca-<name>.pem` is one issuing DevID CA alone, the file SPIRE's `devid.caChains` lists. `folly-devid-ca-<name>-chain.pem` is that CA up to the FML root, for fleetd. `folly-devid-ca.pem` bundles every issuing DevID CA. `<cluster>-sa-signer.pub` is the public key of that cluster's ServiceAccount token signer, which the JWKS carries.
- `csr/` holds the CSR of each hardware DevID CA, whose key a YubiKey on an anchor generated. `mise run devid:yubikey:sign <host>` has OpenBao sign it into `certs/folly-devid-ca-<host>.pem`.
- `oidc/<cluster>/` holds each cluster's OIDC discovery documents, served at `https://oidc.lolwtf.ca/<cluster>`. `.github/workflows/oidc.yml` publishes them.
- `apps/fml-pki/` is the Go tool that checks the chain and derives the OIDC documents.

`mise run pki:verify` checks the chain, signatures and path lengths in `certs/` and needs no secrets.

## Rotate a ServiceAccount token signer

The signer key of `<cluster>` is `serviceAccount.key` in its Talos secrets bundle, the 1Password item `talos-<cluster>-secrets`. A token names its key by `kid`, the SHA-256 of the key's SubjectPublicKeyInfo, and a verifier finds the key in the JWKS, so the JWKS must carry the new key before any token is signed with it, and the old key until no token signed with it is alive.

1. Write the new key's public half beside the old one, as `certs/<cluster>-sa-signer-next.pub`.
2. Write the documents with both keys, and commit them.

   ```bash
   go -C apps/fml-pki run . jwks -issuer https://oidc.lolwtf.ca/<cluster> -out terraform/pki/oidc/<cluster> \
     certs/<cluster>-sa-signer.pub certs/<cluster>-sa-signer-next.pub
   ```

3. Put the new key into the bundle and apply the cluster's Talos root, as [Apply an OpenTofu change](https://wiki.lolwtf.ca/runbooks/apply-an-opentofu-change/) describes. The API servers sign with the new key from their next start.
4. After the longest token lifetime, rename `-next.pub` over `<cluster>-sa-signer.pub`, write the documents with it alone, and commit them.
