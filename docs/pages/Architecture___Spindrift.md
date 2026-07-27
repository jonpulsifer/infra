icon:: 🌀
tags:: architecture

- Spindrift is the deploy control plane in `apps/spindrift/`. Flux installs it on offsite from `clusters/offsite/apps/spindrift/`; it is a platform workload and never one of its own Apps.
- ## Ownership boundary
	- Platform desired state remains GitOps-first. Flux owns the control-plane namespace, shared operators, authentication proxy, admission policy, target namespace and RBAC, and the offsite edge workload under `clusters/`.
	- Spindrift talks directly to delegated APIs after those prerequisites exist. On Kubernetes it owns `HelmRelease` resources in `spindrift-apps`; in GCP it owns App resources inside the App's pre-provisioned vessel project. It never creates a cluster, namespace, project, VPC, tunnel, signing key, or policy engine.
	- Operators and agents still author platform changes in git. Direct API reconciliation is authority granted to the running Spindrift controller, not a second manual apply path.
- ## Identity and targets
	- The installer chart at `packages/charts/spindrift/` gives the reconciler audience-bound projected tokens while the web process receives no API credential. Offsite's Kubernetes token reaches the local API and federates to folly through the folly API server's OIDC claim validation in `nix/services/k8s/`.
	- The reconciler's GCP token uses the offsite provider in the `fml-pool` workload identity pool. The chart renders an external-account credential file for Application Default Credentials; IAM grants name the exact offsite Spindrift ServiceAccount subject.
	- `clusters/base/platform/spindrift-target/` is the shared least-privilege target surface. It limits delivery to the App namespace, source inspection to Flux's `infra` repository, and discovery to the capabilities Spindrift reports.
- ## Vessel and supply chain
	- `bluenose` is the home project and default shared GCP vessel. The organization root adopts its project boundary; `terraform/gcp/projects/bluenose/` owns the vessel's platform prerequisites. Atlantis applies both roots.
	- Build artifacts and signing stay in `trusted-builds`. Spindrift can invoke builds and sign the one artifact digest; vessel runtimes receive pull-only access. Cloud Run is restricted to the vessel's enforcing Binary Authorization policy.
	- Kyverno is installed on both clusters from `clusters/base/platform/kyverno/`. The Spindrift image policy in `clusters/base/platform/spindrift-policy/` rejects an unsigned digest at admission and keeps background reporting enabled, using the public half of the `trusted-builds` signer.
- ## Exposure
	- The App chart at `packages/charts/spindrift-app/` renders no route for Internal, an HTTPRoute with the shared oauth2-proxy ExternalAuth filter for Private, and a filter-free route for Public. The cross-namespace grant belongs to the shared proxy platform resources.
	- The dedicated Cloudflare tunnel is the only published origin for generated App hostnames. Its wildcard Access application is the Target's default Private audience and admits the operator identity.
	- Public exposure fails closed at the edge: a Component hostname remains covered by wildcard Access until Spindrift's Cloudflare adapter declares a more-specific bypass application. The Kubernetes route can be filter-free without making the App accidentally public while that adapter is absent.
- ## Current control-plane state
	- The offsite release runs the web process and its CNPG store. The reconciler Deployment stays disabled because its executable entrypoint is not present; the platform prerequisites and delegated identities remain declared for that process.
	- The installer and App charts are sourced from the `infra` GitRepository. Their OCI publication path is not declared, so a Target cannot claim an independently pinned chart artifact.
