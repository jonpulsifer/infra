# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

Multi-layer homelab infrastructure managed as code: NixOS bare metal hosts, Kubernetes clusters, Terraform-managed cloud/network resources, and GitOps-driven app deployments.

## Development Environment

Prefer `mise` for portable repo tooling:

```bash
mise install
```

This provides common Kubernetes, Terraform, SOPS, 1Password, and cloud CLIs without
requiring a Nix-capable host. Use the Nix flake for NixOS-specific builds,
formatting, and deploy workflows:

```bash
nix develop
# Provides: nixos-rebuild and the full Nix development shell
```

### Claude Code on the web

[Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web) runs in a
freshly-cloned, ephemeral container that ships only `bun`, `go`, and `node`/`npm`. A
**SessionStart hook** (`.claude/hooks/session-start.sh`, registered in `.claude/settings.json`)
bootstraps the validation toolchain on session start so linters, `terraform validate`, and tests
work out of the box. It runs **only** in the web env, **synchronously**, and is idempotent.

It installs `mise` plus a curated set of validation tools — `terraform`, `terraform-docs`,
`shellcheck`, `shfmt`, `kustomize`, `helm` — and the 1Password CLI (`op`) straight from
1Password's CDN (mise's `op` backends need an out-of-scope GitHub clone that the web env's
network policy blocks). The heavier CLIs (`gcloud`, `k9s`, `cilium-cli`, …) and Nix are
intentionally skipped; run the full `mise install` on demand if you need them.

Environment variables relevant to web sessions:

- `CLAUDE_CODE_REMOTE` — set to `true` by the harness in the web env; the hook keys off it to stay web-only.
- `CLAUDE_ENV_FILE` — file the hook appends to in order to persist vars into the session (`PATH`, the two below).
- `CLAUDE_PROJECT_DIR` — repo root, used for the hook path in `.claude/settings.json`.
- `MISE_YES=1` — non-interactive `mise`.
- `MISE_TASK_RUN_AUTO_INSTALL=0` — stops `mise run <task>` from auto-installing the *entire*
  `mise.toml` toolchain (which would fail on the out-of-scope `op` plugin); tasks use the curated tools instead.
- `OP_SERVICE_ACCOUNT_TOKEN` (optional) — if set, `op` can fetch creds non-interactively; otherwise `op` is present but unauthenticated.

Cluster/state secrets are intentionally **not** provisioned in web sessions: Terraform applies go
through Atlantis on the PR and `kubectl` is inspection-only with no cluster creds, so validation is
limited to `init -backend=false && validate`, lint, build, and unit tests.

## How Changes Ship (GitOps + Atlantis)

This repo is GitOps-first: author desired state in git and let the operators apply it. Do not mutate live infra directly.

- **Terraform** (network roots under `network/`: `unifi/folly`, `unifi/offsite`, `cloudflare/`, `tailscale/`; the rest under `terraform/`: `gcp/`, `argo/`, `google-workspace/`, `vault/`; reusable modules in `terraform/modules/`): applies run through **Atlantis** on the PR. Open a PR — Atlantis autoplans the changed module(s); comment `atlantis apply` to apply (a successful apply automerges). Locally, `terraform init`/`plan` and `init -backend=false && validate` are for inspection only. **Never run `terraform apply` against remote state** — it races Atlantis and causes lock contention / drift. CI (`terraform.yml`) only validates. See the `kubernetes-gitops` skill for the Atlantis ↔ ArgoCD auth + token-rotation details.
- **Kubernetes** (`clusters/**`): changes deploy via **Flux** (and **ArgoCD** for apps sourced from external repos) on merge to `main`. Commit manifests; **never `kubectl apply`** to author state. `kubectl`, `flux get`, and `flux reconcile` are for inspection or forcing a sync. Use explicit contexts (`--context folly` / `--context offsite`) and namespaces.
- **NixOS** (`nix/**`): `nixos-rebuild` is the apply path (see Key Commands). State changes that may mutate live hosts should be called out before running.

## Key Commands

### Nix / NixOS

```bash
# Validate the entire flake
nix flake check

# Format all Nix files
nix fmt

# Build a host configuration (does not deploy)
nix build .#nixosConfigurations.<hostname>.config.system.build.toplevel

# Deploy to a remote host immediately
nixos-rebuild switch --flake .#<hostname> --target-host <hostname> --sudo

# Deploy safely (activates on next reboot)
nixos-rebuild boot --sudo --target-host <hostname> --flake .#<hostname>

# Update all flake inputs
nix flake update

# Rollback a system
sudo nixos-rebuild switch --rollback
```

### Terraform

```bash
cd terraform/<module-dir>   # e.g. terraform/gcp/projects/homelab-ng (network roots live under network/, e.g. network/cloudflare, network/unifi/folly)
terraform init
terraform plan    # local inspection only — applies go through Atlantis on the PR (see "How Changes Ship")

# Format (CI auto-formats on merge to main)
terraform fmt -recursive

# Validate without a backend
terraform init -backend=false && terraform validate
```

### Kubernetes / GitOps

K8s apps deploy automatically via ArgoCD and FluxCD when changes merge to `main`. Manual interaction:

```bash
# Check flux kustomization status
flux get kustomizations -A

# Force reconcile
flux reconcile kustomization <name> -n flux-system

# Decrypt a SOPS secret for inspection
sops -d clusters/folly/networking/tailscale/secret.sops.yaml
```

### Secrets (SOPS)

SOPS encrypts `data` and `stringData` fields in files matching `clusters/.*\.sops\.ya?ml`. The age key must be available.

```bash
# Edit an encrypted file
sops clusters/folly/config/cluster-secrets.sops.yaml

# Encrypt a new file (must match path regex in .sops.yaml)
sops -e -i clusters/<cluster>/<path>.sops.yaml
```

## Architecture

### Layer 1 – Bare Metal: `nix/`

NixOS configurations for all physical hosts, declared in `flake.nix`. Host configs import modular components:

- `nix/hosts/<hostname>.nix` – per-host entry point
- `nix/hardware/` – hardware-specific settings (pi4, pi5, x86)
- `nix/services/` – optional service modules (`k8s/`, `common.nix`, `jellyfin.nix`, etc.)
- `nix/system/` – core modules: SSH hardening, Tailscale, auto-upgrades, users
- `nix/overlays/` – package patches and overrides

Hosts fall into two groups: Kubernetes nodes (folly cluster: nuc/optiplex/riptide/800g2; offsite cluster: oldschool/retrofit) and standalone Pis (cloudpi4, homepi4, screenpi4).

### Layer 2 – Kubernetes: `clusters/`

Two clusters managed with FluxCD kustomizations:

- `clusters/folly/` – primary on-site cluster
- `clusters/offsite/` – backup cluster
- `clusters/base/` – resources shared by both clusters (referenced by path from each)

Each cluster directory has `flux-system/` (FluxCD source-of-truth kustomizations), `networking/` (Cilium, cert-manager, Cloudflare tunnel, Gateway API, external-dns), `monitoring/` (kube-prometheus-stack, Loki, Grafana, promtail), `nodes/` (Intel device plugins, node-feature-discovery), and `storage/`.

Cilium provides CNI + BGP load balancer (pools defined in `networking/cilium/ip-pools.yaml`). The Gateway API (`networking/gateway-api/`) handles ingress via a `cluster-gateway` with Cloudflare Tunnel as the external entry point.

The Flux **bootstrap** (the `flux-operator`/`flux-instance` install and node labels) is Terraform, and lives per-cluster in `clusters/<site>/bootstrap/` (e.g. `clusters/folly/bootstrap/bootstrap.tf`).

**Network facts have a single source of truth: the per-cluster `cluster-topology` ConfigMaps at `clusters/<site>/config/cluster-topology.json`** (cluster IPs/CIDRs, API-server endpoints, BGP ASNs/addresses). Each JSON file **is** the Flux ConfigMap (applied as-is — JSON is valid YAML) and doubles as the structured facts every layer reads, so there is no generator. `data` is flat `string→string` (a Flux `substituteFrom` requirement), so lists/numbers are encoded as strings (e.g. `CLUSTER_DNS` is comma-separated, `API_SERVER_PORT` is a string). Do not hardcode these — reference the SSOT: Flux substitutes `${VAR}` from it via `postBuild.substituteFrom`; Nix reads it with `builtins.fromJSON` in `nix/services/k8s/networks.nix` (parsing the port to an int and splitting the DNS list); Terraform roots read it with `jsondecode(file(".../cluster-topology.json")).data` (a `topology.tf` per root). (Not yet migrated: the FRR `*.conf` BGP files and `network/tailscale/policy.hujson` still hold literals.)

### Layer 3 – Cloud & Network: `terraform/` and `network/`

Terraform root modules live under `terraform/` (cloud/identity) and `network/` (the network fabric, brought out front). Each is a standalone module. CI validates and auto-formats on push to `main`.

Network fabric — `network/`:

- `network/unifi/folly/` – primary-site UniFi: VLANs, BGP config, client management (state prefix `terraform/unifi`, kept for continuity)
- `network/unifi/offsite/` – offsite UniFi: networks, WANs, WLANs, BGP (state prefix `terraform/unifi/offsite`)
  - **Cross-site k8s reachability** (folly ⇄ offsite over the single Site Magic tunnel) is gated by the **gateway firewall**, not the routing protocol: iBGP between the gateways carries the pod CIDRs + LB VIP pools, but a gateway only forwards them if its firewall allows the **full k8s address space** (pod CIDRs + VIP pools, not just node subnets). folly enforces this in `firewall.tf` (custom `Lab` zone); offsite uses the permissive default `Internal` zone. See `network/unifi/folly/README.md`.
- `network/cloudflare/` – DNS zones (pulsifer.ca, wishin.app, lolwtf.ca), Cloudflare Tunnels, security rules
- `network/tailscale/` – devices, routes, ACL policy

Cloud & identity — `terraform/`:

- `terraform/gcp/organization/` – org-level IAM, folders, projects, billing
- `terraform/gcp/projects/<name>/` – per-project resources (homelab-ng, firebees, lolcorp, etc.)
- `terraform/argo/` – ArgoCD application definitions (Terraform-managed)
- `terraform/google-workspace/` – Google Workspace users, groups, domains
- `terraform/vault/` – HashiCorp Vault auth, mounts, policies
- `terraform/modules/` – reusable modules (gce-vpc, gke-cluster, gke-nodepool, …) consumed by the roots via relative paths

### Layer 4 – Applications, Packages & Images

First-party code and container/image builds, separate from the infra layers:

- `apps/` – deployable services: `agent-web` (one Dockerfile, `--build-arg AGENT_SET={full,pi}`; publishes the `ai-agents` image — the `pi` variant still builds but is no longer published), `hermes`, `minecraft`, `thehive`, `cortex`, `tidbyt` (Starlark/Pixlet Tidbyt apps), `ddnsd` (Go Cloudflare DDNS daemon, consumed by NixOS hosts via `nix/system/ddnsd.nix`), `view-counter` (Go GCP Cloud Function deployed via `.github/workflows/view-counter.yml`), and `netbench` (Go web UI that runs `iperf3` benchmarks across nodes/LANs/clusters; servers are the `clusters/base/apps/iperf3` hostNetwork DaemonSet plus NixOS `services.iperf3` on the bare Pis via `nix/services/iperf3.nix`)
- `packages/` – reusable building blocks: `agent-web-ui` (shared TS/Bun frontend + PTY server, a root Bun workspace member) and `charts/` (the `app` and `ai-agent` Helm charts; Flux HelmReleases reference them as `packages/charts/<name>` against the `infra` GitRepository)
- `images/` – base & tool OCI images (`base`, `openclaw`, `bashcurljq`, `atlantis`, `actions-runner`, …) plus `cloudlab-linux` (Packer/preseed VM-image build tooling)

`containers.yml` builds the images on changes under `apps/`, `packages/`, or `images/`.

### CI/CD

- **`terraform.yml`**: validates changed `.tf` files (discovered dynamically), then auto-formats and regenerates terraform-docs on merge to `main`
- **`trivy.yml`**: scans `.tf` and `clusters/**` for CRITICAL/HIGH IaC vulnerabilities
- **`containers.yml`**: builds container images from `apps/`, `packages/`, `images/`
- **Renovate**: opens PRs for Helm chart, container image, and Terraform provider updates automatically

## Dotfiles Integration

Dotfiles live in-repo under `dotfiles/` (formerly the standalone `jonpulsifer/dotfiles` repo, merged in via `git filter-repo`). They are **chezmoi-managed**, not a flake input — there is no `dotfiles` flake input and no home-manager.

- The repo-root `.chezmoiroot` contains `dotfiles`, so chezmoi treats the `dotfiles/` subdirectory as its source root.
- On NixOS hosts, `nix/system/chezmoi.nix` carries the `dotfiles/` tree into the system closure (via the flake source) and runs `chezmoi apply --source <store-path>` in an activation script (for the `jawn` user) — no network clone, and it self-heals on every rebuild/boot. The module is imported on cluster/Pi hosts through `nix/services/common.nix`, and directly by the WSL image (`nix/images/wsl.nix`).
- The WSL image (`.github/workflows/nix-image-builder.yaml`) builds a plain tarball; dotfiles are applied by that same activation script on first boot, so the workflow does no build-time chezmoi seeding.

Editing dotfiles (e.g. zsh config in `dotfiles/dot_config/zsh/`) ships to hosts on the next `chezmoi apply` / rebuild — no separate repo to update.

## Skills

Repo-local agent skills follow the [agentskills.io](https://agentskills.io) `SKILL.md` format and live in `.agents/skills/<name>/SKILL.md`.

Available skills:
- `validate-build` — Nix flake check, kustomize build, terraform validate before commit
- `nixos-deploy` — build, deploy, and roll back NixOS hosts
- `terraform` — Terraform workflow, module layout, CI behaviour
- `kubernetes-gitops` — FluxCD reconciliation, networking, SOPS secrets
- `multi-cluster` — Add or modify shared resources across folly and offsite clusters using the base/ pattern
- `onboard-repo` — Vendor an external jonpulsifer repo into apps/packages/images with history, then rewire its consumers
- `unifi-network` — Read-only discovery of the live UniFi homelab network (networks/VLANs, WLANs, devices, clients) via the UDM Pro API, creds from 1Password
