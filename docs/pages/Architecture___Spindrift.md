icon:: 🌀
tags:: architecture

- Spindrift is the deploy control plane in `apps/spindrift/`. Flux installs it on offsite from `clusters/offsite/apps/spindrift/`; it is a platform workload and never one of its own Apps.
- ## Ownership boundary
	- Platform desired state remains GitOps-first. Flux owns the control-plane namespace, shared operators, authentication proxy, admission policy, target namespace and RBAC, and the offsite edge workload under `clusters/`.
	- Spindrift talks directly to delegated APIs after those prerequisites exist. On Kubernetes it owns `HelmRelease` resources in `spindrift-apps`; in GCP it owns App resources inside the App's pre-provisioned vessel project. It never creates a cluster, namespace, project, VPC, tunnel, signing key, or policy engine.
	- Operators and agents still author platform changes in git. Direct API reconciliation is authority granted to the running Spindrift controller, not a second manual apply path.
- ## Identity and targets
	- The installer chart at `packages/charts/spindrift/` gives both processes the same audience-bound projected tokens. The web process holds them because it needs them: log tailing and the connect screen's cluster probe both cross the deploy-adapter seam. Offsite's Kubernetes token reaches the local API and federates to folly through the folly API server's OIDC claim validation in `nix/services/k8s/`.
	- The reconciler's GCP token uses the offsite provider in the `fml-pool` workload identity pool. The chart renders an external-account credential file for Application Default Credentials; IAM grants name the exact offsite Spindrift ServiceAccount subject.
	- `clusters/base/platform/spindrift-target/` is the shared least-privilege target surface. It limits delivery to the App namespace, source inspection to Flux's `infra` repository, and discovery to the capabilities Spindrift reports.
- ## Vessel and supply chain
	- `bluenose` is the home project and default shared GCP vessel. The organization root adopts its project boundary; `terraform/gcp/projects/bluenose/` owns the vessel's platform prerequisites. Atlantis applies both roots.
	- Build artifacts and signing stay in `trusted-builds`. Spindrift can invoke builds and sign the one artifact digest; vessel runtimes receive pull-only access. Cloud Run is restricted to the vessel's enforcing Binary Authorization policy.
	- Kyverno is installed on both clusters from `clusters/base/platform/kyverno/`. The Spindrift image policy in `clusters/base/platform/spindrift-policy/` rejects an unsigned digest at admission and keeps background reporting enabled, using the public half of the `trusted-builds` signer.
- ## Config delivery
	- Spindrift writes config values into the installation's secret store and keeps only pinned references. The App chart renders an `ExternalSecret` per configured Component, and `clusters/base/platform/onepassword-connect/` is the store the offsite Target fetches through.
	- A Target's `ClusterSecretStore` is operator-stated in that Target's chart-values. The chart refuses to render config without it rather than producing an ExternalSecret that never syncs.
	- Config that cannot follow a Component to another Target is named and demanded before the move commits, because Spindrift reads no value back and so cannot copy one.
- ## Reach and auth
	- A Component states two independent facts: `reach` is `none`, `private`, or `public`; `auth` is `none` or `proxy`. `auth: proxy` with `reach: none` is refused — there is no route to filter.
	- The App chart at `packages/charts/spindrift-app/` renders an HTTPRoute when `reach` is not `none`, and the Gateway API `ExternalAuth` filter exactly when `auth` is `proxy`. The cross-namespace grant belongs to the shared proxy platform resources; the chart renders no Gateway and no certificate.
	- The record type is the boundary. `reach: private` publishes an unproxied A record at the shared Gateway's load-balancer address, which is RFC1918 and so is unreachable from the internet whatever is attached to it. `reach: public` publishes a proxied CNAME at the Target's Cloudflare tunnel, whose ingress stays the single static wildcard rule Terraform owns.
	- Each Target asserts which reaches it serves and which its authenticated edge can stand in front of. A Component asking for something a Target does not assert is a non-candidate at placement with a stated reason, rather than a green Deploy behind a route that answers nothing.
	- `{reach: public, auth: proxy}` is expressible and unmet on offsite: `clusters/base/apps/oauth2-proxy/` admits a single GitHub user, which is an honest edge in front of a private address and a false one in front of a public one.
- ## Current control-plane state
	- The offsite release runs the web process, the reconciler, and their CNPG store. The reconciler supervises the target, config, deploy, build, manifest, and — where a repository integration exists — repository loops, each with its own retry chain.
	- Both charts under `packages/charts/` are published as OCI artifacts by `.github/workflows/spindrift-charts.yml` and consumed through `OCIRepository` sources pinned by tag — the installer's beside its release in `clusters/offsite/apps/spindrift/`, the App chart's in `clusters/base/platform/spindrift-target/` so every Target cluster carries its own. A rendered Component release names that object, so no deploy depends on a checkout of this repository.
	- Spindrift places workloads and never removes one. Deleting an App and disconnecting a Target both strand what is running, deliberately — neither act calls the deploy adapter, because tearing down a live service is not what either one says. The adapter's `destroy` verb therefore has no caller, and a stranded object is the operator's to reap by hand until an explicit teardown act exists.
