# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

Multi-layer homelab infrastructure managed as code: NixOS bare metal hosts, Kubernetes clusters, Terraform-managed cloud/network resources, and GitOps-driven app deployments.

## Development Environment

All tools are provided by the Nix flake. Enter the shell before doing anything:

```bash
nix develop
# Provides: kubectl, helm, terraform, vault, sops, fluxcd, cilium-cli, gcloud, nixos-rebuild
```

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
nixos-rebuild switch --flake .#<hostname> --target-host <hostname> --use-remote-sudo

# Deploy safely (activates on next reboot)
nixos-rebuild boot --use-remote-sudo --target-host <hostname> --flake .#<hostname>

# Update all flake inputs
nix flake update

# Rollback a system
sudo nixos-rebuild switch --rollback
```

### Terraform

```bash
cd <module-dir>   # e.g. gcp/projects/homelab-ng, cloudflare, vault, argo, unifi
terraform init
terraform plan
terraform apply

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
sops -d k8s/clusters/folly/networking/tailscale/secret.sops.yaml
```

### Secrets (SOPS)

SOPS encrypts `data` and `stringData` fields in files matching `k8s/.*\.sops\.ya?ml`. The age key must be available.

```bash
# Edit an encrypted file
sops k8s/clusters/folly/config/cluster-secrets.sops.yaml

# Encrypt a new file (must match path regex in .sops.yaml)
sops -e -i k8s/clusters/<cluster>/<path>.sops.yaml
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

### Layer 2 – Kubernetes: `k8s/`

Two clusters managed with FluxCD kustomizations:

- `k8s/clusters/folly/` – primary on-site cluster
- `k8s/clusters/offsite/` – backup cluster

Each cluster directory has `flux-system/` (FluxCD source-of-truth kustomizations), `networking/` (Cilium, cert-manager, Cloudflare tunnel, Tailscale, Gateway API, external-dns), `monitoring/` (kube-prometheus-stack, Loki, Grafana, promtail), `nodes/` (Intel device plugins, node-feature-discovery), and `storage/`.

Cilium provides CNI + BGP load balancer (pools defined in `networking/cilium/ip-pools.yaml`). The Gateway API (`networking/gateway-api/`) handles ingress via a `cluster-gateway` with Cloudflare Tunnel as the external entry point.

### Layer 3 – Cloud & Network: `gcp/`, `cloudflare/`, `vault/`, `argo/`, `unifi/`

Each directory is a standalone Terraform module. CI validates and auto-formats on push to `main`.

- `gcp/organization/` – org-level IAM, folders, projects, billing
- `gcp/projects/<name>/` – per-project resources (homelab-ng, firebees, lolcorp, etc.)
- `cloudflare/` – DNS zones (pulsifer.ca, wishin.app, lolwtf.ca), Cloudflare Tunnels, security rules
- `vault/` – AppRole/GCP/JWT auth backends, PKI, policies
- `argo/` – ArgoCD application definitions (Terraform-managed)
- `unifi/` – VLANs, BGP config, client management

### CI/CD

- **`terraform.yml`**: validates changed `.tf` files, then auto-formats and regenerates terraform-docs on merge to `main`
- **`trivy.yml`**: scans `.tf` and `k8s/**` for CRITICAL/HIGH IaC vulnerabilities
- **Renovate**: opens PRs for Helm chart, container image, and Terraform provider updates automatically

## Dotfiles Integration

Home-manager user config is pulled from `github:jonpulsifer/dotfiles` via the `dotfiles` flake input. The relevant outputs consumed here are:

- `dotfiles.homeModules.basic` — base home-manager config for all standard hosts (`nix/system/user.nix`)
- `dotfiles.homeModules.full` — full dev stack for WSL image (`nix/images/wsl.nix`)
- `dotfiles.overlays.default` — package overlays (includes `llm-agents.nix`, `shell-utils`)

The dotfiles flake no longer exports `nixosModules` — use `homeModules` instead.

## Skills

Repo-local agent skills follow the [agentskills.io](https://agentskills.io) `SKILL.md` format and live in `.agents/skills/<name>/SKILL.md`.

Available skills:
- `nixos-deploy` — build, deploy, and roll back NixOS hosts
- `terraform` — Terraform workflow, module layout, CI behaviour
- `kubernetes-gitops` — FluxCD reconciliation, networking, SOPS secrets
