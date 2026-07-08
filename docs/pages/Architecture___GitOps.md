icon:: 🔁
tags:: architecture

- How a change actually ships, by layer. The common thread: author desired state in git, let an operator apply it. Rationale in [[ADR/0001 GitOps apply model]].
- ## Terraform → Atlantis
	- Open a PR touching a root module → Atlantis autoplans it → review → comment `atlantis apply` → a successful apply automerges the PR.
	- Local `terraform plan` is inspection-only; applying locally races Atlantis and corrupts locks.
- ## Kubernetes → Flux (+ ArgoCD)
	- Merge to `main` → Flux reconciles `clusters/**`. ArgoCD deploys apps sourced from external repos (definitions in `terraform/argo/`).
	- `flux reconcile kustomization <name> -n flux-system` forces a sync; `kubectl` is for inspection.
- ## NixOS → nixos-rebuild + auto-upgrade
	- `nixos-rebuild switch/boot --flake .#<host> --target-host <host>` is the apply path, and hosts also auto-rebuild from GitHub `main` — so out-of-band or branch deploys silently revert unless merged promptly.
- ## CI workflows
	- `terraform.yml` — validates changed `.tf` files; auto-formats + regenerates terraform-docs on merge
	- `containers.yml` — builds container images from `apps/`, `packages/`, `images/`
	- `trivy.yml` — scans `.tf` and `clusters/**` for CRITICAL/HIGH IaC vulnerabilities
	- `wiki.yml` — builds this wiki from `docs/` and deploys it to Cloudflare Pages
	- `pulsifer-ca.yml` — builds and deploys the Hugo site to GitHub Pages
	- `nixos-deploy.yaml`, `nix-ci.yaml`, `nix-image-builder.yaml` — NixOS build/deploy pipelines
	- **Renovate** opens PRs for Helm charts, container images, Terraform providers, and GitHub Actions
- ## The bootstrap exceptions
	- Two places where a layer reaches into another: the Flux bootstrap (`clusters/<site>/bootstrap/` Terraform installs `flux-operator`/`flux-instance`), and the Atlantis ↔ ArgoCD auth wiring (see [[Runbooks/Kubernetes GitOps Change]] for token rotation).
