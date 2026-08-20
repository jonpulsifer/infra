# terraform/pki — FML PKI & cluster OIDC issuers

Issues the per-cluster **FML K8s CAs** and **ServiceAccount token
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

## Trust anchor constraints

The chain is Root → Intermediate → FML K8s `<cluster>` CA → leaf. Two CAs follow
the root and one follows the intermediate, so `pathLenConstraint` must be at
least 2 and 1 respectively.

The anchors carry those values, in 1Password and under `certs/` alike, and
neither expires: both hold `99991231235959Z`.

An anchor holding less than the chain requires forbids the chain it signs: no
client can build a full path through it, and OpenSSL reports `path length
constraint exceeded`. Go's `crypto/x509` treats every certificate in a trust
store as an anchor and stops there, so it never walks past the published cluster
CA and never sees the contradiction; kubectl, Flux and Prometheus are
unaffected. OpenSSL-based clients are not.

`scripts/pki/reissue-trust-anchors.sh` mints replacements that keep both keys,
both subjects and both subject key identifiers, so the new certificates are
drop-in — everything already issued beneath them names its issuer by that
identifier. It needs the offline root key. `mise run pki:verify` checks linkage,
signatures, `CA:TRUE`, pathLen depth and expiry ordering across everything under
`certs/`, and needs no secrets.

The certificate handling lives in `apps/fml-pki`, standard library only, so the
toolchain needs `go` and nothing else — no openssl, which neither mise's registry
nor the dev shell carries. It also derives the OIDC documents and answers the
fingerprint and key-match questions `post-rotate.sh` asks.

Both anchors carry `99991231235959Z`, RFC 5280's "no well-defined expiration
date". They are distributed out of band and pinned by every node, so an expiry
on them buys a fleet-wide outage on a date nobody is watching rather than any
security. Rotation is exercised on the cluster CAs beneath them, which stay
deliberately short-lived. `--root-days` and `--intermediate-days` bound an
anchor instead, if that trade is ever worth making.

`max_path_length = 0` on the per-cluster CAs does not take effect. The provider
sets the template field, but `x509.CreateCertificate` omits `pathLenConstraint`
unless `MaxPathLenZero` is also set, which the provider has no way to express,
so the issued certificates carry no constraint. Setting 1 emits `pathLen:1`,
which places the fault in the zero value rather than the fork. The
intermediate's pathLen:1 bounds the depth from above for any full-path
validator.

## Two bundles, and why they are not one

`certs/<cluster>-ca-bundle.pem` is a **rotation overlap set** — the current CA
plus the previous one during a changeover. It feeds
`services.kubernetes.caFile`.

`certs/<cluster>-ca-chain.pem` is the **trust chain** — the cluster CA, the FML
Intermediate, and the FML Root. `kube-controller-manager` publishes it through
`--root-ca-file`, which becomes `kube-root-ca.crt` and every pod's `ca.crt`
(wired in `nix/services/k8s/default.nix`). The cluster CA is not self-signed, so on its own an OpenSSL
client cannot build a path out of it and fails with `unable to get issuer
certificate`.

**Never merge the chain into `caFile`.** That option also backs `clientCaFile`
and `kubeletClientCaFile`, so putting the FML anchors there would make the API
server accept any client certificate issued anywhere under the FML Root as
authentication — a certificate with `O=system:masters` away from cluster-admin.
Only `--root-ca-file` takes the chain. `mise run pki:verify` asserts the chain
file links to a self-signed root and starts with the right cluster CA.

## Export and rotation

Cluster CAs expire in August 2028. Their shorter lifetime is intentional: the
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
valid. Overlap is keyed on the **public key**, not the certificate: a
certificate reissued for the same key verifies every signature the old one did,
so the helper writes no `*-prev.pem` for it. When a key does change, the helper
moves the current certificate to `certs/<cluster>-ca-prev.pem` and builds
`certs/<cluster>-ca-bundle.pem` with new and previous CAs. Stage that bundle on
every Kubernetes client and server, reissue all TLS leaves from the new CA, and
verify the fleet before deleting `*-ca-prev.pem` and rerunning the helper.
Rollback restores the prior git revision (including its SOPS ciphertext), then
redeploys the overlap bundle and rebuilds the affected hosts.

Because a same-key reissue leaves the SOPS plaintext untouched, sops-nix sees no
change and restarts nothing. `cfssl` keeps serving the certificate it started
with and `kube-controller-manager` never republishes `kube-root-ca.crt`, so both
need restarting by hand on each control plane after the rebuild.

<!-- BEGIN_TF_DOCS -->
<!-- END_TF_DOCS -->
