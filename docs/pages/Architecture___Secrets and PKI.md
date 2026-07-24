icon:: 🔐
tags:: architecture

- This wiki is public (wiki.lolwtf.ca). Nothing decrypted — no secret values, keys, tokens, or recovery material — ever lands in `docs/`.
- ## SOPS (Kubernetes cluster secrets)
	- `.sops.yaml` matches `clusters/.*\.sops\.ya?ml` and encrypts only the `data` and `stringData` fields (`encrypted_regex: "^(data|stringData)$"`); the rest of the manifest — `apiVersion`, `kind`, `metadata` — stays plaintext and diffable.
	- These files decrypt against a single shared age recipient (the fleet's cluster-secrets key). Flux decrypts them in-cluster at reconcile time.
	- ```bash
	  sops clusters/folly/config/cluster-secrets.sops.yaml   # edit
	  sops -e -i clusters/<cluster>/<path>.sops.yaml         # encrypt a new file
	  ```
- ## sops-nix (bare NixOS host secrets)
	- `nix/secrets/<host>.sops.yaml` holds secrets for a single bare host — currently `optiplex`, `retrofit`, and `oldschool`. Each file has its own `.sops.yaml` rule keyed to that host's own age recipient (an ssh-to-age conversion of its ed25519 SSH host key), in addition to the shared key.
	- `nix/system/sops.nix` sets `sops.age.sshKeyPaths` to the host's own `/etc/ssh/ssh_host_ed25519_key` — sops-nix decrypts on the host using its own key rather than a fleet-wide shared key, so a compromised host only exposes secrets scoped to itself.
	- `flake.nix` wires each host's `sops.defaultSopsFile` and declares its secrets: `optiplex` and `retrofit` (both `role = "control-plane"`) carry `k8s-sa-signing-key` (owner `kubernetes`, restarts `kube-apiserver`/`kube-controller-manager`); `oldschool` carries `harmonia-cache-key` for its binary-cache signing (the matching public key is committed at `nix/secrets/oldschool-harmonia-cache.pub`).
	- `k8s-sa-signing-key` is the per-cluster ServiceAccount token signer private key issued by `terraform/pki` — see PKI below.
- ## OpenBao
	- Deployed by Flux from `clusters/folly/apps/vault/` (HelmRelease `vault`, chart `openbao`, namespace `vault`). No other cluster runs it.
	- Storage is integrated Raft (`storage "raft"`, single node `vault-openbao-0`); no external database.
	- Auto-unseal is `seal "gcpckms"` against a GCP KMS key isolated to OpenBao (key ring `openbao`, crypto key `openbao`, project `homelab-ng`, region `northamerica-northeast1`, provisioned in `terraform/gcp/projects/homelab-ng/kms.tf`).
	- OpenBao authenticates to GCP with no static key file: a projected ServiceAccount token (audience `fml-pool`/provider `folly`) is exchanged via GCP Workload Identity Federation for short-lived access as the `vault-id` GSA, which holds the KMS grants. The federation provider is the folly cluster's own OIDC issuer — the same issuer PKI below sets up — so unsealing depends on that cluster's ServiceAccount token signing working.
	- Reachable at `vault.${SECRET_DOMAIN}` (folly's Gateway/cert-manager) once bootstrapped.
	- Bootstrapping (init, unseal verification, first policies) is a runbook, not architecture: [[Runbooks/OpenBao Bootstrap]].
- ## PKI (`terraform/pki`)
	- Trust chain, root to leaf:
		- **FML Root CA** — offline; only its certificate (no key) is read from 1Password. Never touched by Terraform.
		- **FML Intermediate CA** — certificate and key both read from 1Password at plan/apply time (so the key transits Terraform state, a deliberate tradeoff given state lives in the IAM-gated homelab-ng bucket).
		- **FML K8s `<cluster>` CA** — issued here per cluster (`folly`, `offsite`), signed by the intermediate. `CA:TRUE`, `pathLen:0` (may only sign leaves, never another CA). ~2 year validity.
		- **`<cluster>` ServiceAccount token signer** — a leaf issued here per cluster, signed by that cluster's K8s CA. RSA-4096, 1 year validity.
	- Requires OpenTofu specifically (`opentofu/tls` provider fork, for `max_path_length` — not published for plain Terraform).
	- Each cluster's kube-apiserver signs ServiceAccount tokens with its signer key (delivered to the control-plane hosts via sops-nix as `k8s-sa-signing-key`, above) and advertises issuer `https://oidc.lolwtf.ca/<cluster>`.
	- The discovery documents (`oidc/<cluster>/{openid-configuration.json,jwks.json}`, JWKS `kid` = `base64url(SHA256(SPKI))` of the signer) are committed in `terraform/pki/` and served at `oidc.lolwtf.ca` via Cloudflare Pages (domain/DNS in `terraform/network/cloudflare/oidc.tf`, deployed by `.github/workflows/oidc.yml`).
	- That issuer is also a GCP Workload Identity Federation provider (`fml-pool`, one provider per cluster, in `terraform/gcp/projects/homelab-ng/workload-identity.tf`) — the mechanism OpenBao uses to reach its KMS key above, and available to any other in-cluster workload that needs federated GCP access.
	- Rotation is a runbook step (`scripts/pki/post-rotate.sh` re-encrypts signer keys and regenerates the discovery documents) — see `terraform/pki/README.md`.
- ## ArgoCD / Atlantis authentication
	- `terraform/argo/` is the root module for the `argocd` Terraform provider (`use_local_config = true`: it authenticates through a local ArgoCD session rather than an explicit token in the module). Atlantis applies it like any other root. The token/session wiring is scoped and rotated, not a shared static credential — see [[Architecture/GitOps]] for the apply flow and the runbook it points to for rotation.
