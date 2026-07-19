icon:: 📦
tags:: architecture

- **Layer 4.** First-party code, separate from the infra layers. `containers.yml` builds OCI images on changes under `apps/`, `packages/`, or `images/`.
- ## `apps/` — deployable services
	- `agent-web` — AI agent web environment; one Dockerfile with `--build-arg AGENT_SET={full,pi}`, publishes the `ai-agents` image
	- `ddnsd` — Go Cloudflare DDNS daemon, consumed by NixOS hosts via `nix/system/ddnsd.nix`
	- `netbench` — Go web UI running `iperf3` benchmarks across nodes/LANs/clusters; servers are the `clusters/base/apps/iperf3` hostNetwork DaemonSet plus `services.iperf3` on the bare Pis
	- `view-counter` — Go GCP Cloud Function (deployed by `view-counter.yml`)
	- `orgpolicyauditor` — Google Cloud Function auditing the GCP organization IAM policy
	- `pulsifer.ca` — the personal site: Hugo + Tailwind CSS v4, deployed to GitHub Pages by `pulsifer-ca.yml`
	- `rackstat` — Go aggregator condensing rack-top homelab status for Tronbyt
	- `wishin`, `tempest` — Starlark/Pixlet Tidbyt apps; each app directory doubles as the `apps/<name>/<name>.star` layout that `tronbyt-server`'s git-repo app discovery expects
	- `hermes`, `systemd` — supporting services and images
- ## Deployment ownership
	- An `apps/` path does not imply an OCI image. Container-backed apps are classified in `.github/containers.json`; host-native services such as `ddnsd` carry an app-local Nix package/module and are built through Nix CI.
	- [[Hosts/spore]] runs no first-party app: it is the NFS + netboot server. dnsmasq/TFTP + a static nginx tree serve x86 PXE, and a root-only publisher (`nix/services/spore-native-boot.nix`) serves rackpi5's signed `boot.img`/`boot.sig`/`nix-store.squashfs` as static files at `/rackpi5-ram/`. See [[ADR/0014 Collapse Spore to a static netboot server]].
- ## `packages/` — reusable building blocks
	- `agent-web-ui` — shared TS/Bun frontend + PTY server (root Bun workspace member)
	- `charts/` — the `app` and `ai-agent` Helm charts; Flux HelmReleases reference them as `packages/charts/<name>` against the `infra` GitRepository
- ## `images/` — base & tool OCI images
	- `base`, `openclaw`, `bashcurljq`, `atlantis`, `actions-runner`, … plus `cloudlab-linux` (Packer/preseed VM-image tooling)
- ## This wiki
	- The `docs/` directory is itself an application of sorts: a Logseq graph published to [wiki.lolwtf.ca](https://wiki.lolwtf.ca) — see [[ADR/0009 Logseq wiki on Cloudflare Pages]].
