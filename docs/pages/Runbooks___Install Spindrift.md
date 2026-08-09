tags:: runbook, spindrift, terraform, kubernetes

- Use this to stand up a Spindrift installation from nothing: the Terraform that provisions what it federates into, the Flux-delivered chart consumer, the first-operator passkey enrolment, and connecting Targets. What Spindrift is and where its ownership boundary sits is [[Architecture/Spindrift]] — this page only installs it. The clean-install shape is proven by `clusters/offsite/apps/spindrift-acceptance/`, a second installation declared to answer exactly the question this runbook asks; treat that directory as the exemplar throughout, and read its file comments — they state why each value is what it is.
- # Before you start
	- Everything here ships through git. Terraform applies through Atlantis on the PR ([[Runbooks/Terraform Change]]); Kubernetes applies on merge to `main` through Flux ([[Architecture/GitOps]]). Nothing below is a `kubectl apply` or a local `tofu apply`.
	- The operator age key from [[Runbooks/SOPS Secrets and Age Keys]] is needed to author the installation Secret.
	- Pick the control plane's hostname before anything else. It must be a real origin: the first-operator ceremony is a passkey scoped to it, and a browser refuses a ceremony whose relying party is not a suffix of the origin it is on — an installation with a placeholder hostname cannot enrol anybody.
- # Terraform bootstrap
	- Four roots provision what a new installation federates into. Each applies through Atlantis on its own PR; the roots carry the detail, so this section names what each provides and points.
	- ## The vessel project — `terraform/gcp/projects/bluenose/`
		- The home vessel. `vessel.tf` calls `terraform/modules/spindrift-vessel` (enabled APIs, the `spindrift-runtime` service account the controller acts as, the controller's project roles, the Binary Authorization admission policy) and `terraform/modules/vessel-network` (VPC, subnet, private service connection). `config/vessel-topology.json` is the SSOT for the subnet CIDR.
		- `iam.tf` carries what only the home vessel has: the `spindrift-controller` service account, the federation bindings that let a cluster identity impersonate it, and each cluster's read path into this vessel's Secret Manager.
		- A new vessel project is a page: backend, providers, the services and roles lists in its own `services.tf` and `iam.tf`, and the module call. The module's README says why the two lists live in the root's files rather than beside the module.
	- ## Federation — `terraform/gcp/projects/homelab-ng/workload-identity.tf`
		- The `fml-pool` workload identity pool, one provider per cluster. A subject is `<cluster>:system:serviceaccount:<namespace>:<name>` — so an installation in a new namespace is a new subject, and it holds nothing until `terraform/gcp/projects/bluenose/iam.tf` binds it. The acceptance installation's two bindings there — `roles/iam.workloadIdentityUser` and `roles/iam.serviceAccountTokenCreator` on `spindrift-controller` — are the worked example; a new installation copies their shape with its own namespace in the subject.
	- ## Supply chain — `terraform/gcp/projects/trusted-builds/`
		- The KMS signing key (`kms.tf`), the `provenance` Binary Authorization attestor, and the `i` Artifact Registry repository. The installation manifest's `supplyChain` block names all three, which is how the running installation registers them — the exemplar's `helm-release.yaml` shows the block.
		- The registry sweeps images older than 24h by design: it is admission staging, and ghcr.io holds the durable copy of every digest. An empty repository is the policy working, not a missing artifact.
	- ## The Apps edge — `terraform/network/cloudflare/spindrift.tf`
		- The tunnel a `reach: public` App is served through, its single static wildcard ingress rule, and the escrow of the tunnel credential into 1Password (homelab vault, "spindrift cloudflared").
	- The shared cluster prerequisites are already Flux-owned on both clusters through `clusters/base/platform/` — Kyverno and the `spindrift-policy` image admission, the `spindrift-target` least-privilege surface, the `gcp-secret-manager` `ClusterSecretStore`. A new installation does not redeclare them.
- # Declare the installation
	- The chart is `packages/charts/spindrift`. `.github/workflows/spindrift-charts.yml` publishes it to `oci://ghcr.io/jonpulsifer/charts/spindrift` on every merge that touches it, tagged with the version its `Chart.yaml` carries — bumping the chart without bumping the consumer's tag ships nothing, and the workflow's header comment explains the pairing.
	- A new installation is one directory under `clusters/offsite/apps/`, added to that level's `kustomization.yaml`. Copy the exemplar's shape: its own `kustomization.yaml`, `namespace.yaml`, `ca-bundle.yaml`, `secret.sops.yaml`, an `oci-repository.yaml` pinning the published chart by version, and a `helm-release.yaml`.
	- The values a first install stands or falls on — the exemplar carries every one, with the reasoning inline:
		- `image` — pinned by digest.
		- `hostname` — the real origin. The chart renders the Gateway and HTTPRoute from it; cert-manager issues the certificate and external-dns publishes the record, so this one line is the whole edge. The `${SPINDRIFT_DOMAIN}` substitution is defined in `clusters/base/cluster-settings.yaml` (the offsite config patches that base), and `${SECRET_DOMAIN}` comes from the cluster secrets, both via the Flux apps Kustomization.
		- `serviceAccount.token.gcpAudience` and `gcpImpersonationUrl` — the cluster's `fml-pool` provider and the `spindrift-controller` impersonation URL. This is the identity the Terraform above binds; a mismatch between the namespace here and the subject in `iam.tf` is refused at every GCP call.
		- `serviceAccount.token.caConfigMap` — **not** the chart's default `kube-root-ca.crt`. The runtime does no partial-chain verification, so the bundle must reach the FML root; the certificates come from `terraform/pki/certs/`, and the exemplar's `ca-bundle.yaml` comment records the exact failure sentence the default produces.
		- `envFromSecret` — the installation Secret, next section.
		- `database.enabled` — the chart declares a CNPG `Cluster` named `<release>-db` beside the two processes, with a migration Job that holds both below Ready until the schema is present. [[Runbooks/Managed Postgres]] is how to reach it. `keepOnDelete` decides whether uninstalling keeps the rows.
		- `reconciler.enabled` — the second process off the same image; nothing deploys without it.
	- `manifest:` is optional and seeds only an installation that has no stored row yet. Omit it and a placeholder seeds the row, with every genuine choice made in the product ("Configure in the product" below). Once a row exists the mounted declaration is ignored — correcting a value on a running installation is the UI's job, not a redeploy.
- # The installation Secret
	- `envFromSecret` names a sops-encrypted Secret in the installation's namespace carrying two keys:
		- `SPINDRIFT_ENROLMENT_TOKEN` — the token the first operator spends to claim the installation. Consumed on use; rotating it in this Secret is the whole recovery procedure.
		- `SPINDRIFT_CREDENTIAL_KEYRING` — the versioned keyring durable connector credentials are encrypted under (one active key, legacy keys decrypt only). Without it a registry or GitHub credential has nowhere durable to be kept. The document's shape is defined in `apps/spindrift/src/crypto/credential-envelope.ts`.
	- Author it like any cluster secret: `clusters/**/*.sops.yaml` matches the first creation rule in `.sops.yaml` and encrypts `data`/`stringData` to the operator key. The mechanics are on [[Runbooks/Kubernetes GitOps Change]]; key handling is on [[Runbooks/SOPS Secrets and Age Keys]]. Generate both values fresh — never reuse another installation's. A keyring key is exactly 32 bytes, base64url-encoded: `bun -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` mints one (`openssl rand -base64` emits `+/=` characters the keyring refuses).
- # Deliver and verify
	- Merge the PR. Flux applies `clusters/` on `main`; forcing a sync and chasing a stale revision are covered by [[Runbooks/Kubernetes GitOps Change]].
	- Watch the chain come up, in dependency order:
	- ```bash
	  flux --context offsite get sources oci -n <namespace>
	  flux --context offsite get helmreleases -n <namespace>
	  kubectl --context offsite cnpg status <release>-db -n <namespace>
	  kubectl --context offsite get pods -n <namespace>
	  ```
	- An `OCIRepository` stuck at `OCIArtifactPullFailed` with a 401 means the GHCR chart package is private — a fresh GHCR package is created private on first push and has to be flipped to public on its settings page once; neither consumer carries a `secretRef`.
	- Both Deployments hold below Ready until the migration Job's journal is present; a pending Job usually means the database is still bootstrapping.
- # Enrol the first operator
	- Open `https://<hostname>`. One screen, two states: an installation nobody has claimed shows enrolment, a claimed one shows sign-in, and there is no toggle between them.
	- Enter the value of `SPINDRIFT_ENROLMENT_TOKEN` and complete the passkey ceremony. The ceremony is scoped to the origin in the address bar; the token is consumed on use, so the window in which anyone else could claim the installation closes the moment enrolment completes.
	- Recovery — a lost device, a compromised token — is rotating `SPINDRIFT_ENROLMENT_TOKEN` in the Secret and enrolling again: spending a token whose hash the installation has not seen replaces every credential and session that came before it. There is no reset endpoint; editing the Secret is the procedure.
- # Configure in the product
	- First sign-in on a placeholder-seeded installation lands in the onboarding wizard. It asks the genuine choices — what the installation is called, whose GitHub App it speaks as, where its artifacts publish — confirms the cloud facts discovery read, and writes once at the end. Everything else is derived from the chart or from discovery, and the settings surface keeps every key afterwards.
- # Connect Targets and repositories
	- Targets → Connect is probe-then-confirm: give an address, the probe reads what is there and writes nothing, the discovered components (gateway, authenticated edge, config store) come back as cards to include or leave out, and confirm writes the Target. Connect always succeeds — the checklist that follows is the test, and unlike a preflight it keeps being true tomorrow.
	- An unmet prerequisite row carries the Terraform that clears it and the root it belongs in; Spindrift opens the stanza as a pull request on this repository and Atlantis applies it. The boundary — Spindrift proposes, Terraform owns — is stated on [[Architecture/Spindrift]].
	- A Kubernetes Target on the control plane's own cluster also needs what the running installation declares beside its release in `clusters/offsite/apps/spindrift/`: the Apps `Gateway` with its pinned address and wildcard certificate (`gateway.yaml`), and the bindings granting the installation's ServiceAccount the shared target surface (`target-rbac.yaml`, against `clusters/base/platform/spindrift-target/`).
	- Connecting a repository is a GitHub App device grant: press Connect, Spindrift shows a user code and the verification URL, and the operator enters the code there as the GitHub user. The App's repository access on GitHub gates what can be connected — a repository the App is not installed on cannot appear.
