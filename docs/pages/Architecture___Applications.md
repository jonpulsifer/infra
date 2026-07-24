icon:: 📦
tags:: architecture

- **Layer 4.** First-party code and image builds, separate from the infra layers (`nix/`, `clusters/`, `terraform/`).
- ## The three directories
	- `apps/` — deployable services: things with a runtime, a deploy target, and a lifecycle. Browse the directory for the current set.
	- `packages/` — reusable building blocks other apps import or reference: shared frontend code, TypeScript config, Helm charts. Not deployed on their own.
	- `images/` — base and tool OCI images: build environments and CI runners, not application services.
	- The line isn't Dockerfile-presence — several `apps/` entries have no Dockerfile (Starlark apps, the Hugo site, `apps/ddnsd`'s Nix-only deploy path) and one `packages/` entry (`charts/`) has none either. The line is deploy target: an app ships somewhere (a cluster, a Cloud Function, a static host, a NixOS closure); a package is consumed by an app's build.
- ## The root Bun/Turborepo workspace
	- `package.json` declares `workspaces: ["apps/*", "packages/*"]`, so **every** directory under `apps/` and `packages/` is nominally a Bun workspace member — but only the ones with their own `package.json` actually participate in `bun install`/`turbo build`. Check for a `package.json` in the app's directory to know which regime it's in.
	- TypeScript/Bun members today: `apps/hub`, `apps/slingshot`, `apps/wiki`, `packages/agent-web-ui`, `packages/k6`, `packages/typescript-config`. These get `bun run {lint,typecheck,build,test}` via `turbo.json`, Biome formatting/linting (`biome.json`), and CI in `.github/workflows/typescript.yml`.
	- Everything else is standalone and brings its own toolchain, invoked directly (not through `turbo`):
		- Go apps carry their own `go.mod` and are built/tested with `go build`/`go test`, not the Bun workspace.
		- Starlark/Pixlet Tidbyt apps have no build step in this repo at all — see below.
		- `apps/pulsifer.ca` is a Hugo + Tailwind site with its own `mise.toml` (pinned `hugo`/`tailwindcss`), deployed by `.github/workflows/pulsifer-ca.yml`.
		- `apps/agent-web` and `apps/hermes` are pure Dockerfiles (no `package.json`, no `go.mod`) — the image build IS the app.
- ## How something becomes a published container
	- `containers.yml` triggers on changes under `apps/**`, `packages/**`, or `images/**` and runs `.github/scripts/detect-containers.sh`, which:
		- finds every `Dockerfile` under `apps/` and `images/` (not `packages/`)
		- reads an optional `build.json` next to it for custom image name/context/build-args/watch-paths (default: image name = directory name, context = directory)
		- requires every discovered image name to appear in exactly one of `.github/containers.json`'s `build` (published to `ghcr.io/jonpulsifer/<image>`) or `ignore` (has a Dockerfile, deliberately not published here) lists — an unclassified image **fails CI**, so a new Dockerfile can't be silently published or silently dropped
		- only rebuilds images whose watch paths actually changed (or all of them, if the workflow/script/manifest itself changed)
	- To add a published image: add a `Dockerfile` (plus optional `build.json` for a custom image name or multi-image directory — `apps/agent-web/build.json` produces the single `ai-agents` image from `--build-arg AGENT_SET=full`), then add its image name to `containers.json`'s `build` list. To add an unpublished-but-present Dockerfile (a base layer another image `FROM`s, a local-only build), add it to `ignore` instead.
- ## The Nix carve-out
	- `apps/ddnsd` is Go source vendored in-repo; `nix/overlays/ddnsd.nix` builds it as a Nix package (`callPackage ../../apps/ddnsd/package.nix`) and `nix/system/ddnsd.nix` imports `apps/ddnsd/module.nix` to run it as a `systemd` service, configured per-host (zone, token file) with `services.ddnsd.enable`. This is how homelab hosts actually run `ddnsd` — through the NixOS closure, not a container.
	- `apps/ddnsd` also has a `Dockerfile` and IS in `containers.json`'s `build` list, so `ghcr.io/jonpulsifer/ddnsd` exists — the README documents it as a general-purpose Cloudflare DDNS client for anyone, container included. The two facts coexist: the image is published for external/portable use; this repo's own deployment path for it is Nix, not that image.
- ## Helm charts: how Flux consumes `packages/charts/`
	- `packages/charts/` holds first-party charts (`app`, `ai-agent`) with no Dockerfile of their own. A `HelmRelease` references one by relative path against the `infra` `GitRepository`, e.g. `clusters/offsite/apps/hub/helm-release.yaml`:
		- ```yaml
		  chart:
		    spec:
		      chart: packages/charts/app
		      reconcileStrategy: Revision
		      sourceRef:
		        kind: GitRepository
		        name: infra
		        namespace: flux-system
		  ```
	- `reconcileStrategy: Revision` means Flux re-renders the chart whenever the `infra` `GitRepository` advances — no chart version bump or separate chart repo needed. The `HelmRelease` supplies the built container image (e.g. `ghcr.io/jonpulsifer/hub:latest@sha256:...`) as a value.
- ## Apps consumed by an external server's discovery convention
	- Some `apps/` directories aren't structured for this repo's own tooling — they're shaped to satisfy a convention an *external* server expects. The Tidbyt/Pixlet apps (`apps/wishin`, `apps/tempest`, and `apps/rackstat`'s display half) are Starlark `.star` files at the app directory root, because `tronbyt-server`'s git-repo app discovery expects exactly that layout (`apps/<name>/<name>.star`) when pointed at this repo. There's no build step for them in this repo; `tronbyt-server` renders the `.star` directly.
	- `apps/rackstat` is the hybrid case: a Go aggregator (`main.go`, containerized, deployed by Flux from `clusters/folly/apps/tronbyt/`) that serves a JSON snapshot, plus `rackstat.star` — a Pixlet app in the same directory that renders that snapshot for the display. One directory, two consumers (Kubernetes runs the Go binary; `tronbyt-server` discovers the `.star`).
